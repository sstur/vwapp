"""Selectors verified against the US myVW 2026.9.29-9674 app.

The app owns authentication and VW network traffic. This adapter only reads
accessibility nodes and performs ordinary UI actions.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone

from .device import BridgeError, Device, Node, select

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
    charge = [t for t in texts if t in {"Charging", "Not charging", "Charging complete", "Ready to charge"}]
    timers = [re.fullmatch(r"(?:(\d+)h\s*)?(?:(\d+)m\s*)?to (\d+)%", t) for t in texts]
    timers = [m for m in timers if m and (m[1] or m[2])]
    timer = timers[0] if len(timers) == 1 else None
    lock = text_by_id(top, "vehicleModelTextView")
    name = text_by_id(top, "vehicleNameTextView")
    if not name:
        raise BridgeError("UNEXPECTED_UI", "Vehicle name is unavailable")
    return {
        "vin": vin, "name": name, "soc": int(b[1]),
        "rangeKm": round(float(b[2]) * (1.609344 if b[3] == "mi" else 1), 3),
        "chargeState": charge[0] if len(charge) == 1 else None,
        "minutesToTarget": int(timer[1] or 0) * 60 + int(timer[2] or 0) if timer else None,
        "targetSoc": int(timer[3]) if timer else None,
        "locked": {"Locked": True, "Unlocked": False}.get(lock),
        "observedAt": now(), "reportedUpdatedText": text_by_id(top, "timestampTextView"),
        "capturedAt": None, "source": "myVW Android UI",
        "warnings": sorted({n.get("text") for n in top
                            if n.get("package") == PACKAGE and "unavailable" in n.get("text").lower()}),
    }


class MyVW:
    def __init__(self, device: Device, username: str, vin: str):
        self.device, self.username, self.vin = device, username.strip().lower(), vin

    def snapshot(self) -> list[Node]:
        nodes = self.device.nodes()
        if by_id(nodes, "loginButton") or any(n.get("resource-id") in {"input_email", "password"}
                                             and n.get("package") == PACKAGE for n in nodes):
            raise BridgeError("AUTH_REQUIRED", "Sign in to myVW on the phone to continue")
        if by_id(nodes, "title_pin_management"):
            raise BridgeError("PIN_REQUIRED", "Complete the myVW PIN prompt on the phone")
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
            elif by_id(nodes, "climateTitleTextView"):
                self.device.shell("input", "keyevent", "4")
            elif any(n.get("text") == "Garage" for n in nodes):
                self.device.tap(PACKAGE, text=self.vin)
            else:
                time.sleep(1)
        raise BridgeError("UNEXPECTED_UI", "Cannot navigate safely to myVW Home")

    def prepare(self) -> list[Node]:
        self.home()
        # Verify the actual signed-in account, not a host-side remembered label.
        self.tap_id("account_nav_graph")
        self.wait_id("profile_list_item")
        self.tap_id("profile_list_item")
        profile = self.wait_id("update_user_id_list_item")
        emails = {n.get("text").strip().lower() for n in by_id(profile, "subtitleTextView")
                  if "@" in n.get("text")}
        if emails != {self.username}:
            raise BridgeError("ACCOUNT_MISMATCH", "The signed-in myVW account does not match configuration")
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
        controls = self.controls()
        result = parse_status(top, controls, self.vin)
        self.tap_id("climateButton")
        result["climateOn"] = climate_state(self.wait_id("climateTitleTextView"))
        self.device.shell("input", "keyevent", "4")
        result["observedAt"] = now()
        return result

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
