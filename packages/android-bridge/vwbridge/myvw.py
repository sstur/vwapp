"""Selectors verified against the US myVW 2026.9.29-9674 app.

The app owns authentication and VW network traffic. This adapter only reads
accessibility nodes and performs ordinary UI actions.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .device import BridgeError, Device, Node, select
from .readings import activity_page, message_page, direction_coordinates, texts
from .closures import read as read_closures

PACKAGE = "com.vw.carnet.release"
PREFIX = PACKAGE + ":id/"
SUPPORTED_VERSION = "2026.9.29-9674"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def by_id(nodes: list[Node], suffix: str) -> list[Node]:
    return [n for n in nodes if n.get("package") == PACKAGE and n.get("resource-id") == PREFIX + suffix]


def text_by_id(nodes: list[Node], suffix: str) -> str | None:
    values = {n.get("text") for n in by_id(nodes, suffix) if n.get("text")}
    return next(iter(values)) if len(values) == 1 else None


def climate_state(nodes: list[Node]) -> bool:
    title = text_by_id(nodes, "climateTitleTextView")
    off, on = by_id(nodes, "firstCommandTextView"), by_id(nodes, "secondCommandTextView")
    if title != "Climate" or len(off) != 1 or len(on) != 1:
        raise BridgeError("UNEXPECTED_UI", "Climate controls are not uniquely identifiable")
    if off[0].get("text") != "Off" or on[0].get("text") != "On":
        raise BridgeError("UNEXPECTED_UI", "Climate control labels changed")
    flags = off[0].get("enabled"), on[0].get("enabled")
    if flags == ("false", "true"):
        return False
    if flags == ("true", "false"):
        return True
    raise BridgeError("COMMAND_PENDING", "Climate state is not settled")


def parse_status(top: list[Node], controls: list[Node], vin: str) -> dict:
    """Keep app-reported freshness separate from the time we observed the UI."""
    texts = {n.get("text") for n in controls if n.get("package") == PACKAGE}
    battery = [re.fullmatch(r"(\d{1,3})%\s*\|\s*([\d.]+) Est\. (mi|km)", t) for t in texts]
    battery = [m for m in battery if m]
    if len(battery) != 1 or not 0 <= int(battery[0][1]) <= 100:
        raise BridgeError("UNEXPECTED_UI", "Cannot read a unique battery/range value")
    b = battery[0]
    charge = [t for t in texts if t in {"Charging", "Not charging", "Charging complete", "Ready to charge", "Plugged in"}]
    timers = [re.fullmatch(r"(?:(\d+)h\s*)?(?:(\d+)m\s*)?to (\d+)%", t) for t in texts]
    timers = [m for m in timers if m and (m[1] or m[2])]
    timer = timers[0] if len(timers) == 1 else None
    mileage = [re.fullmatch(r"([\d,]+) (mi|km)", t) for t in texts]
    mileage = [m for m in mileage if m]
    lock = text_by_id(top, "vehicleModelTextView")
    name = text_by_id(top, "vehicleNameTextView")
    if not name:
        raise BridgeError("UNEXPECTED_UI", "Vehicle name is unavailable")
    return {
        "vin": vin, "name": name, "soc": int(b[1]),
        "rangeKm": round(float(b[2]) * (1.609344 if b[3] == "mi" else 1), 3),
        "chargeState": charge[0] if len(charge) == 1 else None,
        "pluggedIn": True if "Plugged in" in texts or "Charging" in texts else None,
        "minutesToTarget": int(timer[1] or 0) * 60 + int(timer[2] or 0) if timer else None,
        "targetSoc": int(timer[3]) if timer else None,
        "chargingTargetSoc": int(timer[3]) if timer else None,
        "odometerKm": round(int(mileage[0][1].replace(",", "")) * (1.609344 if mileage[0][2] == "mi" else 1), 3) if len(mileage) == 1 else None,
        "locked": {"Locked": True, "Unlocked": False}.get(lock),
        "observedAt": now(), "reportedUpdatedText": text_by_id(top, "timestampTextView"),
        "capturedAt": None, "source": "myVW Android UI",
        "warnings": sorted({n.get("text") for n in top
                            if n.get("package") == PACKAGE and "unavailable" in n.get("text").lower()}),
    }


class MyVW:
    def __init__(self, device: Device, username: str, vin: str, vehicle_profiles=None):
        self.device, self.username, self.vin = device, username.strip().lower(), vin
        self.credentials = {}
        self.reserve_login = None
        self.login_succeeded = None
        self.login_reservation = None
        self.pin_attempted = False
        self.account_verified = False
        self.authentication_started = False
        self.vehicle_profiles = vehicle_profiles or {}

    def enter_pin(self):
        pin = self.credentials.get("spin")
        if not pin:
            raise BridgeError("PIN_REQUIRED", "Supply the myVW S-PIN to complete sign-in")
        if self.pin_attempted:
            raise BridgeError("PIN_REJECTED", "PIN did not unlock myVW; automatic retries stopped")
        self.reserve_attempt()
        self.pin_attempted = True
        self.authentication_started = True
        self.device.tap(PACKAGE, **{"resource-id": PREFIX + "pin_entry", "class": "android.widget.EditText"})
        self.device.text(pin)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if not by_id(self.device.nodes(), "title_pin_management"):
                return
            time.sleep(1)
        raise BridgeError("PIN_REJECTED", "PIN did not unlock myVW; automatic retries stopped")

    def reserve_attempt(self):
        if self.login_reservation is None and self.reserve_login:
            self.login_reservation = self.reserve_login(self.username)

    def ensure_session(self, credentials, reserve_login, login_succeeded):
        try:
            self._ensure_session(credentials, reserve_login, login_succeeded)
        except Exception:
            # A navigation failure before starting sign-in is not a failed
            # credential attempt. Keep backoff once any authentication begins.
            if self.login_reservation and not self.authentication_started:
                login_succeeded(self.login_reservation)
                self.login_reservation = None
            raise

    def _ensure_session(self, credentials, reserve_login, login_succeeded):
        self.credentials = credentials
        self.reserve_login, self.login_succeeded = reserve_login, login_succeeded
        matched = False
        try:
            self.home()
            actual = self.account_email()
            matched = actual == self.username and not credentials.get("forceLogin", False)
            if actual != self.username or credentials.get("forceLogin", False):
                self.reserve_attempt()
                self.logout()
                self.sign_in()
        except BridgeError as exc:
            if exc.code != "AUTH_REQUIRED":
                raise
            self.reserve_attempt()
            self.sign_in()
        if not matched and self.account_email() != self.username:
            raise BridgeError("ACCOUNT_MISMATCH", "myVW signed into a different account")
        self.account_verified = True
        if self.login_reservation:
            login_succeeded(self.login_reservation)
            self.login_reservation = None
        self.tap_id("home_nav_graph")
        self.wait_id("maincollapsing")

    def account_email(self):
        self.home()
        self.tap_id("account_nav_graph")
        self.wait_id("profile_list_item")
        self.tap_id("profile_list_item")
        nodes = self.wait_id("update_user_id_list_item")
        emails = {n.get("text").strip().lower() for n in by_id(nodes, "subtitleTextView") if "@" in n.get("text")}
        if len(emails) != 1:
            raise BridgeError("UNEXPECTED_UI", "Cannot identify the signed-in account")
        return next(iter(emails))

    def logout(self):
        self.home()
        self.tap_id("account_nav_graph")
        self.wait_id("profile_list_item")
        for _ in range(5):
            if by_id(self.snapshot(), "button_signout"):
                self.tap_id("button_signout")
                self.device.wait(PACKAGE, timeout=45, **{"resource-id": PREFIX + "loginButton", "class": "android.widget.Button"})
                return
            self.device.scroll(PACKAGE, PREFIX + "scrollView")
        raise BridgeError("UNEXPECTED_UI", "Cannot locate myVW logout")

    def sign_in(self):
        email_sent = password_sent = entry_sent = continuation_sent = False
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            nodes = self.device.nodes()
            ids = {n.get("resource-id") for n in nodes if n.get("package") == PACKAGE}
            if any(n.get("resource-id") == "android:id/autofill_save_no" for n in nodes):
                self.device.tap("android", **{"resource-id": "android:id/autofill_save_no"})
            elif PREFIX + "loginButton" in ids and not entry_sent:
                self.authentication_started = True
                self.device.tap(PACKAGE, **{"resource-id": PREFIX + "loginButton", "class": "android.widget.Button"})
                entry_sent = True
            elif "input_email" in ids and not email_sent:
                self.authentication_started = True
                self.device.tap(PACKAGE, **{"resource-id": "input_email"})
                self.device.shell("input", "keyevent", "KEYCODE_MOVE_END")
                self.device.shell("input", "keyevent", "--longpress", "KEYCODE_SHIFT_LEFT", "KEYCODE_MOVE_HOME")
                self.device.shell("input", "keyevent", "KEYCODE_DEL")
                self.device.text(self.username)
                self.device.tap(PACKAGE, **{"resource-id": "next-btn"})
                email_sent = True
            elif "password" in ids and not password_sent:
                self.authentication_started = True
                self.device.tap(PACKAGE, **{"resource-id": "password"})
                self.device.text(self.credentials["password"])
                self.device.shell("input", "keyevent", "4")
                self.device.tap(PACKAGE, **{"resource-id": "next-btn"})
                password_sent = True
            elif PREFIX + "title_pin_management" in ids:
                self.enter_pin()
            elif PREFIX + "continueButton" in ids and not continuation_sent:
                self.tap_id("continueButton")
                continuation_sent = True
            elif PREFIX + "maincollapsing" in ids or any(n.get("text") == "Garage" for n in nodes):
                self.home()
                return
            elif any("incorrect" in n.get("text").lower() or "wrong password" in n.get("text").lower() for n in nodes):
                raise BridgeError("AUTH_FAILED", "myVW rejected the supplied credentials")
            elif any("captcha" in n.get("resource-id").lower() or "verification code" in n.get("text").lower() for n in nodes):
                raise BridgeError("HUMAN_REQUIRED", "Complete the sign-in verification on the phone")
            time.sleep(1)
        raise BridgeError("AUTH_FAILED", "myVW login did not complete; inspect the phone before retrying")

    def garage(self):
        self.home()
        self.device.tap(PACKAGE, **{"class": "android.widget.ImageButton", "resource-id": ""})
        self.device.wait(PACKAGE, text="Garage")
        nodes = self.snapshot()
        vins = list(dict.fromkeys(n.get("text") for n in nodes if n.get("package") == PACKAGE and re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", n.get("text"))))
        if not vins:
            raise BridgeError("NO_VEHICLES", "No vehicles were visible in the myVW garage")
        return [{"vin": vin, "uuid": vin, "nickname": None, "model": None} for vin in vins]

    @staticmethod
    def temperature(nodes):
        values = {int(m[1]) for n in nodes if n.get("package") == PACKAGE
                  for m in [re.fullmatch(r"Set to (\d+)°", n.get("text"))] if m}
        return next(iter(values)) if len(values) == 1 else None

    def snapshot(self) -> list[Node]:
        nodes = self.device.nodes()
        if by_id(nodes, "loginButton") or any(n.get("resource-id") in {"input_email", "password"}
                                             and n.get("package") == PACKAGE for n in nodes):
            raise BridgeError("AUTH_REQUIRED", "Sign in to myVW on the phone to continue")
        if by_id(nodes, "title_pin_management"):
            self.enter_pin()
            return self.snapshot()
        if by_id(nodes, "alertTitle"):
            raise BridgeError("APP_ERROR", "myVW is displaying an error dialog")
        if not any(n.get("package") == PACKAGE for n in nodes):
            raise BridgeError("SCREEN_UNAVAILABLE", "Unlock the phone and make myVW available")
        return nodes

    def tap_id(self, suffix: str) -> None:
        self.device.tap(PACKAGE, **{"resource-id": PREFIX + suffix})

    def wait_id(self, suffix: str, timeout: float = 30) -> list[Node]:
        deadline = time.monotonic() + timeout
        while True:
            nodes = self.snapshot()
            if by_id(nodes, suffix):
                return nodes
            if time.monotonic() >= deadline:
                raise BridgeError("UNEXPECTED_UI", "Expected myVW screen did not appear")
            time.sleep(0.5)

    def home(self) -> list[Node]:
        self.device.shell("input", "keyevent", "224")  # Wake, without dismissing a secure keyguard.
        version = self.device.shell("dumpsys", "package", PACKAGE)
        if not re.search(r"versionName=" + re.escape(SUPPORTED_VERSION) + r"(?:\s|$)", version):
            raise BridgeError("APP_VERSION_CHANGED", "This myVW version needs selector validation")
        self.device.launch(PACKAGE)
        for _ in range(5):
            nodes = self.snapshot()
            if any(n.get("content-desc") == "Home" for n in by_id(nodes, "maincollapsing")):
                return nodes
            if by_id(nodes, "home_nav_graph"):
                self.tap_id("home_nav_graph")
            elif by_id(nodes, "climateSettingsTitle"):
                self.tap_id("climateDepSettingsCancel")
            elif by_id(nodes, "climateTitleTextView") or by_id(nodes, "actionTitleTextView"):
                self.device.shell("input", "keyevent", "4")
            elif by_id(nodes, "settingsDesc") or any(n.get("text") in {
                "Inbox", "Activity History", "Activity history", "Vehicle Information",
                "Vehicle information",
                "Vehicle status updates", "Your Preferred Dealer",
            } for n in nodes if n.get("package") == PACKAGE):
                # These are read/detail screens or unsaved forms. Back cancels,
                # never saves a partially edited battery configuration.
                self.device.shell("input", "keyevent", "4")
            elif any(n.get("text") == "Garage" for n in nodes):
                vins = [n.get("text") for n in nodes if n.get("package") == PACKAGE and re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", n.get("text"))]
                target = self.vin or (vins[0] if vins else "")
                self.device.tap(PACKAGE, text=target)
            else:
                time.sleep(1)
        raise BridgeError("UNEXPECTED_UI", "Cannot navigate safely to myVW Home")

    def prepare(self) -> list[Node]:
        self.home()
        # A v2 job has just verified identity; legacy calls verify each time.
        if not self.account_verified:
            if self.account_email() != self.username:
                raise BridgeError("ACCOUNT_MISMATCH", "The signed-in myVW account does not match the requested account")
            self.tap_id("home_nav_graph")
            self.wait_id("maincollapsing")
        self.device.tap(PACKAGE, **{"class": "android.widget.ImageButton", "resource-id": ""})
        deadline = time.monotonic() + 20
        while True:
            garage = self.snapshot()
            if any(n.get("text") == "Garage" for n in garage):
                break
            if time.monotonic() >= deadline:
                raise BridgeError("UNEXPECTED_UI", "Garage did not appear")
        # Selecting by the VIN prevents acting on a different current vehicle.
        self.device.tap(PACKAGE, text=self.vin)
        return self.wait_id("vehicleNameTextView")

    def controls(self) -> list[Node]:
        for _ in range(5):
            nodes = self.snapshot()
            buttons = by_id(nodes, "climateButton")
            if len(buttons) == 1:
                if buttons[0].get("enabled") != "true":
                    raise BridgeError("COMMAND_PENDING", "myVW is waiting for a vehicle command")
                return nodes
            self.device.scroll(PACKAGE, PREFIX + "nestedScrollView")
        raise BridgeError("UNEXPECTED_UI", "Vehicle controls are unavailable")

    def status(self) -> dict:
        top = self.prepare()
        closures = read_closures(self.device, top, self.vehicle_profiles.get(self.vin))
        controls = self.controls()
        result = parse_status(top, controls, self.vin)
        result.update(closures)
        self.tap_id("climateButton")
        result["targetTempF"] = self.temperature(controls)
        result["climateOn"] = climate_state(self.wait_id("climateTitleTextView"))
        self.device.shell("input", "keyevent", "4")
        # The charging countdown replaces the odometer in the stock app. The
        # cloud retains an explicitly dated last odometer observation when hidden.
        self.home_top()
        result["targetSoc"] = self.battery_target(self.open_battery_settings())
        self.device.shell("input", "keyevent", "4")
        self.tap_id("timestampTextView")
        self.device.wait(PACKAGE, text="Vehicle status updates")
        updates = {}
        for node in self.snapshot():
            children = node.descendants()
            category = text_by_id(children, "detailTitleTextView")
            label = text_by_id(children, "detailTimestampTextView")
            if category in {"Doors", "Locks", "Windows", "Charging"} and label:
                updates[category] = label
        result["reportedUpdates"] = updates
        self.device.shell("input", "keyevent", "4")
        result.update(self.parked_location())
        result["observedAt"] = now()
        return result

    def home_top(self):
        self.home()
        self.tap_id("account_nav_graph")
        self.wait_id("profile_list_item")
        self.tap_id("home_nav_graph")
        return self.wait_id("vehicleNameTextView")

    def climate(self, enabled: bool, timeout: float = 180) -> dict:
        self.prepare()
        self.controls()
        self.tap_id("climateButton")
        before = climate_state(self.wait_id("climateTitleTextView"))
        if before == enabled:
            self.device.shell("input", "keyevent", "4")
            return {"vin": self.vin, "climateOn": enabled, "changed": False,
                    "verification": "app-reported state", "observedAt": now()}
        try:
            self.tap_id("secondCommandTextView" if enabled else "firstCommandTextView")
            return self.await_climate(enabled, timeout)
        except BridgeError as exc:
            if exc.code in {"COMMAND_FAILED", "OUTCOME_UNKNOWN"}:
                raise
            raise BridgeError("OUTCOME_UNKNOWN", "Observation failed after command submission; inspect vehicle state") from exc

    def await_climate(self, enabled: bool, timeout: float) -> dict:
        # Never repeat the action. A timeout is an unknown outcome, not a retry instruction.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            nodes = self.snapshot()
            if by_id(nodes, "climateTitleTextView"):
                self.device.shell("input", "keyevent", "4")
                continue
            buttons = by_id(nodes, "climateButton")
            if len(buttons) == 1 and buttons[0].get("enabled") == "true":
                self.tap_id("climateButton")
                actual = climate_state(self.wait_id("climateTitleTextView"))
                self.device.shell("input", "keyevent", "4")
                if actual != enabled:
                    raise BridgeError("COMMAND_FAILED", "myVW reports the previous climate state")
                return {"vin": self.vin, "climateOn": actual, "changed": True,
                        "verification": "app-reported state after command settled", "observedAt": now()}
            time.sleep(2)
        raise BridgeError("OUTCOME_UNKNOWN", "myVW has not confirmed completion; do not blindly retry")

    def climate_info(self):
        self.prepare()
        nodes = self.controls()
        temp = self.temperature(nodes)
        if temp is None or not 60 <= temp <= 85:
            raise BridgeError("UNEXPECTED_UI", "Cannot read a Fahrenheit climate setpoint")
        return {"targetTempF": temp}

    def wait_controls(self, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            nodes = self.snapshot()
            if by_id(nodes, "climateTitleTextView"):
                self.device.shell("input", "keyevent", "4")
                continue
            buttons = by_id(nodes, "climateButton")
            if len(buttons) == 1 and buttons[0].get("enabled") == "true":
                return nodes
            time.sleep(2)
        raise BridgeError("OUTCOME_UNKNOWN", "myVW did not finish the command; inspect status before retrying")

    def set_climate(self, enabled, temp_f=None):
        if temp_f is None or not enabled:
            return self.climate(enabled)
        self.prepare()
        nodes = self.controls()
        current = self.temperature(nodes)
        if current is None or not 60 <= current <= 85:
            raise BridgeError("UNEXPECTED_UI", "Cannot read a Fahrenheit climate setpoint")
        if current != temp_f:
            # The stock app requires climate to be off when changing temperature.
            self.climate(False)
            self.controls()
            self.tap_id("climateButton")
            self.wait_id("climateTitleTextView")
            self.tap_id("settingsButton")
            self.wait_id("temperatureTextView")
            for _ in range(26):
                text = text_by_id(self.snapshot(), "temperatureTextView") or ""
                match = re.fullmatch(r"(\d+)°", text)
                if not match or not 60 <= int(match[1]) <= 85:
                    raise BridgeError("UNEXPECTED_UI", "Climate temperature control changed")
                actual = int(match[1])
                if actual == temp_f:
                    break
                self.tap_id("climateUpButton" if actual < temp_f else "climateDownButton")
            else:
                raise BridgeError("UNEXPECTED_UI", "Requested temperature is not selectable")
            try:
                self.tap_id("doneButton")
                self.wait_controls()
                if self.temperature(self.snapshot()) != temp_f:
                    raise BridgeError("COMMAND_FAILED", "myVW did not apply the requested temperature")
            except BridgeError as exc:
                if exc.code == "COMMAND_FAILED":
                    raise
                raise BridgeError("OUTCOME_UNKNOWN", "Temperature update was submitted but not confirmed") from exc
        result = self.climate(True)
        result["targetTempF"] = temp_f
        return result

    def lock(self, locked):
        top = self.prepare()
        actual = {"Locked": True, "Unlocked": False}.get(text_by_id(top, "vehicleModelTextView"))
        if actual is None:
            raise BridgeError("UNEXPECTED_UI", "Cannot read the door lock state")
        if actual == locked:
            return {"locked": locked, "changed": False, "observedAt": now()}
        self.controls()
        self.tap_id("lockButton")
        nodes = self.wait_id("actionTitleTextView")
        if text_by_id(nodes, "actionTitleTextView") != "Doors" or text_by_id(nodes, "firstCommandTextView") != "Lock" or text_by_id(nodes, "secondCommandTextView") != "Unlock":
            raise BridgeError("UNEXPECTED_UI", "Door command labels changed")
        try:
            self.tap_id("firstCommandTextView" if locked else "secondCommandTextView")
            self.wait_controls()
            # Returning from Account resets Home's scroll to expose the summary.
            self.tap_id("account_nav_graph")
            self.wait_id("profile_list_item")
            self.tap_id("home_nav_graph")
            nodes = self.wait_id("vehicleModelTextView")
            actual = {"Locked": True, "Unlocked": False}.get(text_by_id(nodes, "vehicleModelTextView"))
            if actual != locked:
                raise BridgeError("COMMAND_FAILED", "myVW did not report the requested door lock state")
            return {"locked": actual, "changed": True, "observedAt": now()}
        except BridgeError as exc:
            if exc.code == "COMMAND_FAILED":
                raise
            raise BridgeError("OUTCOME_UNKNOWN", "Door command was submitted but could not be confirmed") from exc

    def charge(self, enabled):
        top = self.prepare()
        nodes = self.controls()
        state = parse_status(top, nodes, self.vin)["chargeState"]
        if state is None:
            raise BridgeError("UNEXPECTED_UI", "Cannot read the charging state")
        if (state == "Charging") == enabled:
            return {"charging": enabled, "changed": False, "observedAt": now()}
        label = "Start charging" if enabled else "Stop charging"
        # Exact unique label, scoped to myVW; never a toggle at a fixed coordinate.
        select(nodes, PACKAGE, text=label)
        try:
            self.device.tap(PACKAGE, text=label)
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                nodes = self.snapshot()
                values = {n.get("text") for n in nodes if n.get("package") == PACKAGE}
                if (enabled and "Charging" in values and "Stop charging" in values) or (not enabled and "Start charging" in values and "Charging" not in values):
                    return {"charging": enabled, "changed": True, "observedAt": now()}
                time.sleep(2)
            raise BridgeError("OUTCOME_UNKNOWN", "myVW has not confirmed the charging command")
        except BridgeError as exc:
            raise BridgeError("OUTCOME_UNKNOWN", "Charging command was submitted but could not be confirmed") from exc

    def charge_limit(self, target):
        self.prepare()
        nodes = self.open_battery_settings()
        original = self.battery_target(nodes)
        if original == target:
            self.device.shell("input", "keyevent", "4")
            return {"targetSoc": target, "changed": False, "observedAt": now()}
        slider = select(nodes, PACKAGE, **{"resource-id": PREFIX + "sliderRadius"})
        low, high = text_by_id(nodes, "minValueTextView"), text_by_id(nodes, "maxValueTextView")
        if (low, high) != ("50%", "100%") or target not in range(50, 101, 10):
            raise BridgeError("UNEXPECTED_UI", "Battery slider range changed")
        x1, y1, x2, y2 = slider.bounds
        inset = (y2 - y1) / 2
        # Slider endpoints exclude the thumb radius. Re-read the displayed
        # percentage before saving; an imprecise gesture must never be sent.
        x = round(x1 + inset + (target - 50) / 50 * (x2 - x1 - 2 * inset))
        self.device.shell("input", "tap", str(x), str((y1 + y2) // 2))
        edited = self.snapshot()
        if self.battery_target(edited) != target:
            self.device.shell("input", "keyevent", "4")
            raise BridgeError("UNEXPECTED_UI", "Battery slider did not select the requested percentage")
        container = select(edited, PACKAGE, **{"resource-id": PREFIX + "actionLoadingLayout"})
        select(container.descendants(), PACKAGE, **{"class": "android.widget.ImageButton"})
        try:
            self.tap_id("actionLoadingLayout")
            # Saving returns Home immediately; its menu disappears while VW
            # processes the command. Wait, then reopen to confirm persistence.
            self.device.wait(PACKAGE, timeout=240, **{"resource-id": PREFIX + "optionsButton"})
            actual = self.battery_target(self.open_battery_settings())
            self.device.shell("input", "keyevent", "4")
            if actual != target:
                raise BridgeError("COMMAND_FAILED", "myVW did not retain the requested charge limit")
            return {"targetSoc": actual, "changed": True, "observedAt": now(),
                    "verification": "saved battery settings",
                    "warning": "Saved charging-location settings may override the general battery limit."}
        except BridgeError as exc:
            if exc.code == "COMMAND_FAILED":
                raise
            raise BridgeError("OUTCOME_UNKNOWN", "Battery settings were submitted but could not be confirmed") from exc

    def open_option(self, label):
        self.device.wait(PACKAGE, timeout=45, **{"resource-id": PREFIX + "optionsButton"})
        self.tap_id("optionsButton")
        self.device.tap(PACKAGE, text=label)

    def open_battery_settings(self):
        self.open_option("Edit battery settings")
        return self.wait_id("currentPercentageTextView")

    @staticmethod
    def battery_target(nodes):
        value = text_by_id(nodes, "currentPercentageTextView")
        if value is None or not re.fullmatch(r"(?:50|60|70|80|90|100)%", value):
            raise BridgeError("UNEXPECTED_UI", "Cannot read the configured battery target")
        return int(value[:-1])

    def phone_clock(self):
        zone = self.device.shell("getprop", "persist.sys.timezone").strip()
        try:
            return datetime.fromtimestamp(int(self.device.shell("date", "+%s").strip()), ZoneInfo(zone))
        except (ValueError, KeyError):
            raise BridgeError("UNEXPECTED_UI", "Cannot identify the phone's calendar/time zone")

    def scroll_list(self, node):
        x1, y1, x2, y2 = node.bounds
        self.device.shell("input", "swipe", str((x1 + x2) // 2), str(round(y1 + .85 * (y2 - y1))),
                          str((x1 + x2) // 2), str(round(y1 + .25 * (y2 - y1))), "500")

    def activity(self):
        self.prepare()
        reference = self.phone_clock()
        self.open_option("View activity history")
        self.device.wait(PACKAGE, text="Activity History")
        rows, seen, previous, known = [], set(), None, {}
        for _ in range(15):
            nodes = self.snapshot()
            container = select(nodes, PACKAGE, **{"scrollable": "true"})
            signature = tuple(texts(container))
            if signature == previous:
                break
            page = activity_page(container, reference, known)
            for row in page:
                key = (row["at"], row["title"], row["description"])
                if key not in seen:
                    seen.add(key)
                    rows.append(row)
            if len(rows) >= 50:
                break
            previous = signature
            self.scroll_list(container)
        self.device.shell("input", "keyevent", "4")
        return {"events": rows[:50]}

    def messages(self):
        self.prepare()
        reference = self.phone_clock()
        self.tap_id("messageCenterButton")
        self.device.wait(PACKAGE, text="Inbox")
        self.device.tap(PACKAGE, text="Messages")
        self.device.wait(PACKAGE, text="All")
        rows, previous, complete = {}, None, False
        for _ in range(15):
            nodes = self.snapshot()
            container = select(nodes, PACKAGE, **{"scrollable": "true"})
            signature = tuple(texts(container))
            if signature == previous:
                complete = True
                break
            for row in message_page(container, reference):
                rows[row["id"]] = row
            if len(rows) >= 50:
                break
            previous = signature
            self.scroll_list(container)
        if not rows and not any(n.get("text") in {"No messages", "You have no messages"} for n in nodes):
            raise BridgeError("UNEXPECTED_UI", "Inbox layout did not expose any recognizable messages")
        self.device.shell("input", "keyevent", "4")
        return {"messages": list(rows.values())[:50], "complete": complete}

    def parked_location(self):
        self.home()
        self.tap_id("navigation_nav_graph")
        deadline = time.monotonic() + 30
        while True:
            nodes = self.device.nodes()
            prompts = [n for n in nodes if n.get("package") in {"com.google.android.permissioncontroller", "com.android.permissioncontroller"}
                       and n.get("resource-id") in {"com.android.permissioncontroller:id/permission_deny_button", "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button"}
                       and n.get("text") == "Keep approximate location"]
            if len(prompts) == 1:
                self.device.tap(prompts[0].get("package"), text="Keep approximate location")
            elif by_id(nodes, "button_vehicle_location"):
                break
            elif time.monotonic() >= deadline:
                raise BridgeError("UNEXPECTED_UI", "Vehicle map did not become available")
            time.sleep(.5)
        self.tap_id("button_vehicle_location")
        self.device.tap(PACKAGE, **{"content-desc": "Map Marker"})
        nodes = self.wait_id("label_nearest_address")
        address = text_by_id(nodes, "label_nearest_address")
        reported = text_by_id(nodes, "label_lpp_timestamp")
        self.tap_id("button_get_directions")
        try:
            deadline = time.monotonic() + 25
            while True:
                try:
                    lat, lng = direction_coordinates(self.device.shell("dumpsys", "activity", "activities"))
                    break
                except BridgeError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(1)
        finally:
            self.device.launch(PACKAGE)
        self.tap_id("home_nav_graph")
        return {"parkedLat": lat, "parkedLng": lng, "parkedAddress": address,
                "reportedParkedText": reported}
