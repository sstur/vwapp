"""Durable asynchronous boundary. Credentials live only in the active worker's memory."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
from logging.handlers import RotatingFileHandler
import re
import threading
import time

from .device import BridgeError
from .myvw import MyVW

OPERATIONS = {"session", "status", "climate", "lock", "charge", "chargeLimit", "climateInfo", "activity", "messages"}
WRITES = {"climate", "lock", "charge", "chargeLimit"}
LOG = logging.getLogger("vwbridge.jobs")


def configure_logging(path):
    handler = RotatingFileHandler(path, maxBytes=2_000_000, backupCount=4)
    handler.setFormatter(logging.Formatter('%(message)s'))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)


def validate(body):
    if not isinstance(body, dict) or set(body) != {"requestId", "operation", "credentials", "vin", "params"}:
        raise BridgeError("INVALID_REQUEST", "Expected requestId, operation, credentials, vin and params")
    if not isinstance(body["requestId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", body["requestId"]):
        raise BridgeError("INVALID_REQUEST", "Invalid request ID")
    op = body["operation"]
    if not isinstance(op, str) or op not in OPERATIONS:
        raise BridgeError("UNSUPPORTED_OPERATION", "This operation is not supported by the phone adapter")
    creds = body["credentials"]
    if not isinstance(creds, dict) or set(creds) - {"username", "password", "spin", "forceLogin"}:
        raise BridgeError("INVALID_REQUEST", "Invalid credentials")
    if not all(isinstance(creds.get(k), str) and 0 < len(creds[k]) <= 512 for k in ("username", "password")):
        raise BridgeError("INVALID_REQUEST", "Username and password are required")
    if "@" not in creds["username"] or ("spin" in creds and not re.fullmatch(r"\d{4,6}", str(creds["spin"]))):
        raise BridgeError("INVALID_REQUEST", "Invalid username or S-PIN")
    if "forceLogin" in creds and type(creds["forceLogin"]) is not bool:
        raise BridgeError("INVALID_REQUEST", "forceLogin must be a boolean")
    # Reject input we cannot type before signing out of an existing session.
    for key in ("username", "password"):
        value = creds[key]
        if not value.isascii() or "%s" in value or any(c in value for c in "\r\n\x00"):
            raise BridgeError("UNSUPPORTED_INPUT", "Phone text entry requires single-line ASCII without literal %s")
    if body["vin"] is not None and (not isinstance(body["vin"], str) or not re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", body["vin"])):
        raise BridgeError("INVALID_REQUEST", "Invalid VIN")
    if op != "session" and body["vin"] is None:
        raise BridgeError("INVALID_REQUEST", "This operation requires a VIN")
    p = body["params"]
    if not isinstance(p, dict):
        raise BridgeError("INVALID_REQUEST", "Invalid operation parameters")
    allowed = {"climate": {"enabled", "tempF"}, "lock": {"locked"}, "charge": {"enabled"}, "chargeLimit": {"targetSoc"}}.get(op, set())
    required = allowed - {"tempF"}
    if not required <= set(p) <= allowed:
        raise BridgeError("INVALID_REQUEST", "Invalid operation parameters")
    for key in ("enabled", "locked"):
        if key in p and type(p[key]) is not bool:
            raise BridgeError("INVALID_REQUEST", key + " must be a boolean")
    if "tempF" in p and (type(p["tempF"]) is not int or not 60 <= p["tempF"] <= 85):
        raise BridgeError("INVALID_REQUEST", "Temperature must be an integer from 60 to 85 F")
    if "targetSoc" in p and (type(p["targetSoc"]) is not int or p["targetSoc"] not in range(50, 101, 10)):
        raise BridgeError("INVALID_REQUEST", "Charge limit must be 50–100 in steps of ten")
    return body


class Jobs:
    def __init__(self, server):
        self.server = server
        self.lock = threading.Lock()
        self.active = None
        self.last = None
        with server.journal.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation TEXT NOT NULL, created REAL NOT NULL, response TEXT, vin TEXT)')
            if 'vin' not in {r[1] for r in db.execute('PRAGMA table_info(jobs)')}:
                db.execute('ALTER TABLE jobs ADD COLUMN vin TEXT')
            db.execute('CREATE TABLE IF NOT EXISTS uncertain (vin TEXT PRIMARY KEY)')
            db.execute('CREATE TABLE IF NOT EXISTS login_attempts (account TEXT PRIMARY KEY, blocked_until REAL NOT NULL)')
            for row in db.execute("SELECT vin FROM jobs WHERE response IS NULL AND operation IN ('climate','lock','charge','chargeLimit')").fetchall():
                db.execute("INSERT OR IGNORE INTO uncertain VALUES (?)", (row[0] or server.config.get("vin", "*"),))
            db.execute('UPDATE jobs SET response=? WHERE response IS NULL',
                       (json.dumps({"state": "failed", "error": {"code": "OUTCOME_UNKNOWN", "message": "Service restarted during this job. Read status before issuing a new command.", "retryable": False}}),))

    def get(self, rid):
        with self.server.journal.connect() as db:
            row = db.execute('SELECT response FROM jobs WHERE id=?', (rid,)).fetchone()
        if row is None:
            return None
        return {"requestId": rid, **(json.loads(row[0]) if row[0] else {"state": "running"})}

    def submit(self, body):
        validate(body)
        rid, op = body["requestId"], body["operation"]
        # Keyed digest prevents offline password guessing from a stolen journal.
        fingerprint = hmac.new(self.server.config["apiKey"].encode(), json.dumps(body, sort_keys=True).encode(), hashlib.sha256).hexdigest()
        with self.lock:
            with self.server.journal.connect() as db:
                row = db.execute('SELECT fingerprint FROM jobs WHERE id=?', (rid,)).fetchone()
                if row:
                    if not hmac.compare_digest(row[0], fingerprint):
                        raise BridgeError("IDEMPOTENCY_CONFLICT", "Request ID already has different parameters")
                    return self.get(rid)
                if op in WRITES and not self.server.config.get("commandsEnabled", False):
                    raise BridgeError("COMMANDS_DISABLED", "Commands are disabled on this host")
                if not self.server.device_lock.acquire(blocking=False):
                    raise BridgeError("DEVICE_BUSY", "Phone is working on another job. Retry this request ID later.")
                try:
                    db.execute('INSERT INTO jobs (id,fingerprint,operation,created,response,vin) VALUES (?, ?, ?, ?, NULL, ?)', (rid, fingerprint, op, time.time(), body['vin']))
                except BaseException:
                    self.server.device_lock.release()
                    raise
            self.active = rid
            threading.Thread(target=self.run, args=(body,), daemon=True).start()
            return {"requestId": rid, "state": "running"}

    def reserve_login(self, username):
        account = hmac.new(self.server.config["apiKey"].encode(), username.lower().encode(), hashlib.sha256).hexdigest()
        with self.server.journal.connect() as db:
            row = db.execute('SELECT blocked_until FROM login_attempts WHERE account=?', (account,)).fetchone()
            if row and row[0] > time.time():
                raise BridgeError("LOGIN_BACKOFF", "A recent login or PIN attempt failed or is pending. Wait 15 minutes before trying again.")
            # Reserve BEFORE typing, including across crashes. Success clears this.
            db.execute('INSERT OR REPLACE INTO login_attempts VALUES (?, ?)', (account, time.time() + 900))
        return account

    def login_succeeded(self, account):
        with self.server.journal.connect() as db:
            db.execute('DELETE FROM login_attempts WHERE account=?', (account,))

    def run(self, body):
        rid, op, start = body["requestId"], body["operation"], time.monotonic()
        LOG.info(json.dumps({"event": "job_started", "requestId": rid, "operation": op}))
        try:
            c, p = body["credentials"], body["params"]
            if op in WRITES:
                with self.server.journal.connect() as db:
                    if db.execute("SELECT 1 FROM uncertain WHERE vin=? OR vin='*'", (body["vin"],)).fetchone():
                        raise BridgeError("NEEDS_RECONCILIATION", "A prior command has an unknown outcome. Complete a status read before sending another command.")
            if self.server.driver.device is not None:
                self.server.driver.device.deadline = time.monotonic() + 480
            driver = MyVW(self.server.driver.device, c["username"], body["vin"] or "", self.server.config.get("vehicleProfiles"))
            driver.ensure_session(c, self.reserve_login, self.login_succeeded)
            if op == "session":
                result = {"vehicles": driver.garage()}
            elif op == "status":
                result = driver.status()
            elif op == "climate":
                result = driver.set_climate(p["enabled"], p.get("tempF"))
            elif op == "climateInfo":
                result = driver.climate_info()
            elif op == "lock":
                result = driver.lock(p["locked"])
            elif op == "charge":
                result = driver.charge(p["enabled"])
            elif op == "chargeLimit":
                result = driver.charge_limit(p["targetSoc"])
            elif op == "activity":
                result = driver.activity()
            elif op == "messages":
                result = driver.messages()
            response = {"state": "succeeded", "result": result}
        except BridgeError as exc:
            code = "OUTCOME_UNKNOWN" if op in WRITES and exc.code == "JOB_TIMEOUT" else exc.code
            response = {"state": "failed", "error": {"code": code, "message": str(exc), "retryable": exc.code in {"DEVICE_UNAVAILABLE", "UI_UNAVAILABLE", "SCREEN_UNAVAILABLE", "COMMAND_PENDING"}}}
        except Exception as exc:
            # Log type only: arbitrary exception strings can contain UI/credentials.
            LOG.error(json.dumps({"event": "internal_error", "requestId": rid, "exceptionType": type(exc).__name__}))
            response = {"state": "failed", "error": {"code": "OUTCOME_UNKNOWN" if op in WRITES else "INTERNAL_ERROR", "message": "Operation could not be completed. Inspect phone and service logs.", "retryable": False}}
        finally:
            body["credentials"].clear()
            if self.server.driver.device is not None:
                self.server.driver.device.deadline = None
        try:
            with self.server.journal.connect() as db:
                db.execute('UPDATE jobs SET response=? WHERE id=?', (json.dumps(response), rid))
                if op in WRITES and response.get("error", {}).get("code") == "OUTCOME_UNKNOWN":
                    db.execute('INSERT OR IGNORE INTO uncertain VALUES (?)', (body["vin"],))
                if op == "status" and response["state"] == "succeeded":
                    db.execute('DELETE FROM uncertain WHERE vin=?', (body["vin"],))
            self.last = {"requestId": rid, "operation": op, "state": response["state"], "finishedAt": time.time(), "errorCode": response.get("error", {}).get("code")}
            LOG.info(json.dumps({"event": "job_finished", **self.last, "durationMs": round((time.monotonic() - start) * 1000)}))
        finally:
            self.active = None
            self.server.device_lock.release()
