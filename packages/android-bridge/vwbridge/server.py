"""Small private-network API. No generic ADB, tap, shell or screenshot endpoint."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import socketserver
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .jobs import Jobs, configure_logging
from .device import BridgeError, Device
from .myvw import MyVW, now


class Journal:
    def __init__(self, path: Path):
        self.path = path
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT)")
            unknown = json.dumps([409, {"error": "OUTCOME_UNKNOWN", "message": "Service restarted before completion; inspect vehicle state before a new request"}])
            db.execute("UPDATE requests SET response=? WHERE response IS NULL", (unknown,))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def begin(self, request_id: str, body: dict):
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT fingerprint, response FROM requests WHERE id=?", (request_id,)).fetchone()
            if row:
                if row[0] != fingerprint:
                    raise BridgeError("IDEMPOTENCY_CONFLICT", "Request ID was already used with different parameters")
                return json.loads(row[1]) if row[1] else [409, {"error": "COMMAND_PENDING"}]
            db.execute("INSERT INTO requests VALUES (?, ?, NULL)", (request_id, fingerprint))
        return None

    def finish(self, request_id: str, status: int, body: dict):
        with self.connect() as db:
            db.execute("UPDATE requests SET response=? WHERE id=?", (json.dumps([status, body]), request_id))

    def get(self, request_id: str):
        with self.connect() as db:
            row = db.execute("SELECT response FROM requests WHERE id=?", (request_id,)).fetchone()
        if not row:
            return 404, {"error": "NOT_FOUND"}
        return json.loads(row[0]) if row[0] else (202, {"state": "pending"})


def validate_command(body: object, vin: str) -> dict:
    if not isinstance(body, dict) or set(body) != {"requestId", "vin", "enabled"}:
        raise BridgeError("INVALID_REQUEST", "Expected requestId, vin and enabled")
    if not isinstance(body["requestId"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", body["requestId"]):
        raise BridgeError("INVALID_REQUEST", "requestId must be 8–128 letters, digits, underscores or hyphens")
    if type(body["enabled"]) is not bool:
        raise BridgeError("INVALID_REQUEST", "enabled must be a JSON boolean")
    if body["vin"] != vin:
        raise BridgeError("VEHICLE_MISMATCH", "VIN does not match the configured vehicle")
    return body


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def server_bind(self):
        # HTTPServer's reverse-DNS lookup can stall startup on a tailnet.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def __init__(self, address, config, driver, journal):
        self.config, self.driver, self.journal = config, driver, journal
        self.device_lock = threading.Lock()
        self.clients = threading.BoundedSemaphore(16)
        self.jobs = Jobs(self)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.clients.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.clients.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.clients.release()


class Handler(BaseHTTPRequestHandler):
    server: BridgeServer
    server_version = "VWBridge/0.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        pass  # Do not log credentials, URL query strings or vehicle data.

    def reply(self, status: int, body: dict):
        raw = json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # The action and its journal entry have already completed.
        self.close_connection = True

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.config["apiKey"]
        if not hmac.compare_digest(supplied.encode(), expected.encode()):
            self.reply(401, {"error": "UNAUTHORIZED"})
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == "/v2/health":
            self.reply(200, {"service": "vw-android-bridge", "apiVersion": 2,
                             "activeRequestId": self.server.jobs.active, "lastJob": self.server.jobs.last,
                             "commandsEnabled": self.server.config.get("commandsEnabled", False)})
            return
        if self.path.startswith("/v2/jobs/"):
            result = self.server.jobs.get(self.path.removeprefix("/v2/jobs/"))
            self.reply(200 if result else 404, result or {"error": "NOT_FOUND"})
            return
        if self.path.startswith("/v1/requests/"):
            self.reply(*self.server.journal.get(self.path.removeprefix("/v1/requests/")))
            return
        if self.path == "/v1/status" and not self.server.config.get("vin"):
            self.reply(410, {"error": "USE_V2_JOBS"})
            return
        if self.path not in {"/health", "/v1/status"}:
            self.reply(404, {"error": "NOT_FOUND"})
            return
        if not self.server.device_lock.acquire(blocking=False):
            self.reply(409, {"error": "DEVICE_BUSY"})
            return
        try:
            if self.path == "/health":
                connected = self.server.driver.device.run("get-state").strip() == "device"
                self.reply(200, {"connected": connected, "observedAt": now(),
                                 "capabilities": ["status", "climate"],
                                 "commandsEnabled": self.server.config.get("commandsEnabled", False)})
            else:
                self.reply(200, self.server.driver.status())
        except BridgeError as exc:
            self.reply(409, {"error": exc.code, "message": str(exc)})
        except Exception:
            self.reply(500, {"error": "INTERNAL_ERROR"})
        finally:
            self.server.device_lock.release()

    def do_POST(self):
        if not self.authorized():
            return
        if self.path == "/v2/jobs":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 8192 or self.headers.get("Transfer-Encoding"):
                    raise ValueError()
                body = json.loads(self.rfile.read(length))
                result = self.server.jobs.submit(body)
                self.reply(202 if result["state"] == "running" else 200, result)
            except (ValueError, TimeoutError):
                self.reply(400, {"error": "INVALID_REQUEST"})
            except BridgeError as exc:
                self.reply(409 if exc.code in {"DEVICE_BUSY", "IDEMPOTENCY_CONFLICT"} else 400,
                           {"error": exc.code, "message": str(exc)})
            except Exception:
                self.reply(500, {"error": "INTERNAL_ERROR"})
            return
        if self.path != "/v1/climate":
            self.reply(404, {"error": "NOT_FOUND"})
            return
        if not self.server.config.get("commandsEnabled", False):
            self.reply(403, {"error": "COMMANDS_DISABLED"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2048 or self.headers.get("Transfer-Encoding"):
                raise ValueError()
            body = validate_command(json.loads(self.rfile.read(length)), self.server.config.get("vin", ""))
        except (ValueError, TimeoutError):
            self.reply(400, {"error": "INVALID_REQUEST"})
            return
        except BridgeError as exc:
            self.reply(400, {"error": exc.code, "message": str(exc)})
            return
        if not self.server.device_lock.acquire(blocking=False):
            self.reply(409, {"error": "DEVICE_BUSY"})
            return
        request_id = body["requestId"]
        reserved = False
        try:
            cached = self.server.journal.begin(request_id, body)
            if cached:
                self.reply(*cached)
                return
            reserved = True
            result = self.server.driver.climate(body["enabled"])
            result["requestId"] = request_id
            self.server.journal.finish(request_id, 200, result)
            self.reply(200, result)
        except BridgeError as exc:
            result = {"error": exc.code, "message": str(exc), "requestId": request_id}
            if reserved:
                self.server.journal.finish(request_id, 409, result)
            self.reply(409, result)
        except Exception:
            result = {"error": "OUTCOME_UNKNOWN", "requestId": request_id}
            if reserved:
                self.server.journal.finish(request_id, 409, result)
            self.reply(500, result)
        finally:
            self.server.device_lock.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.config.stat().st_mode & 0o077:
        parser.error("Config contains a secret and must have mode 600")
    config = json.loads(args.config.read_text())
    if not isinstance(config.get("apiKey"), str) or len(config["apiKey"]) < 32:
        parser.error("apiKey must contain at least 32 random characters")
    host = config.get("host", "127.0.0.1")
    address = ipaddress.ip_address(host)
    if address.version != 4 or not (address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10")):
        parser.error("Bind only to loopback or the Mac's Tailscale IPv4 address")
    state = args.config.parent / "state"
    state.mkdir(mode=0o700, exist_ok=True)
    lock = (state / "server.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error("A bridge is already running with this configuration")
    driver = MyVW(Device(config["serial"], config.get("adb", "adb")), config.get("username", ""), config.get("vin", ""))
    configure_logging(state / "events.jsonl")
    journal = Journal(state / "requests.sqlite3")
    server = BridgeServer((host, config.get("port", 8791)), config, driver, journal)
    print(f"VW bridge listening on {host}:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        lock.close()


if __name__ == "__main__":
    main()
