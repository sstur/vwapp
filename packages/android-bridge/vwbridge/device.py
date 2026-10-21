"""ADB and accessibility primitives; no app instrumentation or rooting."""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Node:
    attributes: dict[str, str]

    def get(self, key: str) -> str:
        return self.attributes.get(key, "")

    @property
    def bounds(self) -> tuple[int, int, int, int]:
        match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", self.get("bounds"))
        if not match:
            raise BridgeError("INVALID_BOUNDS", "Element has no valid screen bounds")
        x1, y1, x2, y2 = map(int, match.groups())
        if x2 <= x1 or y2 <= y1:
            raise BridgeError("INVALID_BOUNDS", "Element is not visible")
        return x1, y1, x2, y2

    @property
    def center(self) -> tuple[int, int]:
        x1, y1, x2, y2 = self.bounds
        return (x1 + x2) // 2, (y1 + y2) // 2

    def public(self) -> dict[str, str]:
        result = {key: self.get(key) for key in (
            "text", "content-desc", "resource-id", "class", "package",
            "bounds", "enabled", "clickable", "selected", "checked",
        )}
        if self.get("password") == "true":
            result["text"] = "[REDACTED]"
            result["content-desc"] = "[REDACTED]"
        return result


def parse_nodes(xml: str) -> list[Node]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise BridgeError("UI_UNAVAILABLE", "Android returned an invalid UI hierarchy") from exc
    return [Node(dict(node.attrib)) for node in root.iter("node")]


def select(nodes: list[Node], package: str, **attributes: str) -> Node:
    matches = [node for node in nodes if node.get("package") == package
               and node.get("enabled") == "true"
               and all(node.get(key) == value for key, value in attributes.items())]
    if len(matches) != 1:
        raise BridgeError("UNEXPECTED_UI", f"Expected exactly one matching element; found {len(matches)}")
    matches[0].center  # Reject hidden/zero-size elements before acting.
    return matches[0]


class Device:
    def __init__(self, serial: str, adb: str = "adb"):
        if not serial:
            raise BridgeError("CONFIGURATION", "An explicit Android serial is required")
        self.serial = serial
        self.adb = adb
        self.deadline = None

    def run(self, *args: str, timeout: float = 30) -> str:
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeError("JOB_TIMEOUT", "Phone job exceeded its execution budget")
            timeout = min(timeout, remaining)
        try:
            result = subprocess.run([self.adb, "-s", self.serial, *args],
                                    capture_output=True, text=True, timeout=timeout)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise BridgeError("DEVICE_UNAVAILABLE", "ADB did not complete successfully") from exc
        if result.returncode:
            # Never propagate command arguments/output: they can contain credentials.
            raise BridgeError("DEVICE_UNAVAILABLE", "ADB command failed; check device connection and authorization")
        return result.stdout

    def shell(self, *args: str, timeout: float = 30) -> str:
        return self.run("shell", shlex.join(args), timeout=timeout)

    def nodes(self) -> list[Node]:
        # UIAutomator occasionally fails while an app animates. Re-reading is safe;
        # input actions are never automatically retried.
        for attempt in range(3):
            try:
                return self._nodes_once()
            except BridgeError as exc:
                if exc.code not in {"DEVICE_UNAVAILABLE", "UI_UNAVAILABLE"} or attempt == 2:
                    raise
                time.sleep(1)
        raise BridgeError("UI_UNAVAILABLE", "UI hierarchy unavailable")

    def _nodes_once(self) -> list[Node]:
        path = f"/data/local/tmp/vwbridge-{uuid.uuid4().hex}.xml"
        try:
            self.shell("uiautomator", "dump", "--compressed", path)
            return parse_nodes(self.shell("cat", path))
        finally:
            try:
                self.shell("rm", "-f", path, timeout=5)
            except BridgeError:
                pass

    def wait(self, package: str, timeout: float = 25, **attributes: str) -> Node:
        deadline = time.monotonic() + timeout
        while True:
            nodes = self.nodes()
            try:
                return select(nodes, package, **attributes)
            except BridgeError:
                if time.monotonic() >= deadline:
                    raise
            time.sleep(0.5)

    def tap(self, package: str, **attributes: str) -> None:
        # Re-read immediately before acting; no fixed screen coordinates.
        node = select(self.nodes(), package, **attributes)
        x, y = node.center
        self.shell("input", "tap", str(x), str(y))

    def text(self, value: str) -> None:
        if not value.isascii() or "%s" in value or any(c in value for c in "\r\n\x00"):
            raise BridgeError("UNSUPPORTED_INPUT", "ADB text entry requires single-line ASCII")
        self.shell("input", "text", value.replace(" ", "%s"))

    def scroll(self, package: str, resource_id: str, down: bool = True) -> None:
        node = select(self.nodes(), package, **{"resource-id": resource_id, "scrollable": "true"})
        x1, y1, x2, y2 = node.bounds
        x = (x1 + x2) // 2
        start, end = (0.8, 0.2) if down else (0.2, 0.8)
        self.shell("input", "swipe", str(x), str(round(y1 + start * (y2 - y1))),
                   str(x), str(round(y1 + end * (y2 - y1))), "550")

    def launch(self, package: str) -> None:
        resolved = self.shell("cmd", "package", "resolve-activity", "--brief", package)
        components = [line.strip() for line in resolved.splitlines()
                      if line.strip().startswith(package + "/")]
        if len(components) != 1:
            raise BridgeError("APP_UNAVAILABLE", "The configured Android app is not installed")
        self.shell("am", "start", "-n", components[0])


def from_env() -> Device:
    return Device(os.environ.get("VW_ANDROID_SERIAL", ""), os.environ.get("ADB_PATH", "adb"))


def main() -> None:
    """Local setup utility only; never exposed as an HTTP action."""
    import argparse
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["dump", "tap", "launch", "text"])
    parser.add_argument("--package", default="com.vw.carnet.release")
    parser.add_argument("--attribute", default="text")
    parser.add_argument("--value")
    args = parser.parse_args()
    device = from_env()
    try:
        if args.action == "dump":
            for node in device.nodes():
                if node.get("text") or node.get("content-desc") or node.get("clickable") == "true":
                    print(json.dumps(node.public()))
        elif args.action == "tap":
            if args.value is None:
                parser.error("tap requires --value")
            device.tap(args.package, **{args.attribute: args.value})
        elif args.action == "text":
            device.text(sys.stdin.read())
        else:
            device.launch(args.package)
    except BridgeError as exc:
        print(json.dumps({"error": exc.code, "message": str(exc)}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
