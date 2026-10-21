"""Install the bridge as a per-user macOS LaunchAgent (no sudo)."""

import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    label = "com.vwapp.android-bridge"
    domain = f"gui/{os.getuid()}"
    target = Path.home() / "Library/LaunchAgents" / (label + ".plist")
    if args.stop:
        subprocess.run(["launchctl", "bootout", domain + "/" + label], check=False)
        target.unlink(missing_ok=True)
        print("Bridge service removed; configuration and journal retained")
        return
    config = args.config.expanduser().resolve(strict=True)
    if config.stat().st_mode & 0o077:
        parser.error("Config must have mode 600")
    if target.exists():
        parser.error("Service already exists; stop it before reinstalling")
    target.parent.mkdir(parents=True, exist_ok=True)
    definition = {
        "Label": label,
        "ProgramArguments": [sys.executable, "-m", "vwbridge.server", "--config", str(config)],
        "WorkingDirectory": str(Path(__file__).resolve().parent),
        "EnvironmentVariables": {"PYTHONDONTWRITEBYTECODE": "1"},
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "StandardOutPath": str(config.parent / "service.log"),
        "StandardErrorPath": str(config.parent / "service-error.log"),
    }
    target.write_bytes(plistlib.dumps(definition))
    target.chmod(0o600)
    subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
    print("Installed", label)


if __name__ == "__main__":
    main()
