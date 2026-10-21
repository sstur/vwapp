# myVW Android UI bridge

A deterministic Python service on the computer attached to a stock Android phone.
The official US myVW app owns login, integrity checks, session renewal, and VW
network requests. The bridge uses ADB accessibility dumps and ordinary UI input;
there is no agent, root, patched APK, or injected code at runtime.

Implemented: account/VIN verification, battery and charging summary, lock-state
reading, climate-state reading, and climate on/off at the existing setpoint.
There is no temperature change, charging command, door command, account switching,
password-login endpoint, Worker integration, or Cloudflare tunnel yet.

## Setup

Requires Python 3.10+, Android platform tools, and a USB-authorized phone with the
US myVW app installed from Google Play. Complete its login and initial PIN flow.
Leave the phone unlocked. The bridge can wake the screen but cannot unlock a
secure keyguard. It does not change screen-lock settings or reset app data.

On macOS, install platform tools with `brew install --cask android-platform-tools`.
Clone this repository, then work from `packages/android-bridge`:

```sh
mkdir -p ~/.config/vw-android-bridge
chmod 700 ~/.config/vw-android-bridge
cp config.example.json ~/.config/vw-android-bridge/config.json
chmod 600 ~/.config/vw-android-bridge/config.json
adb devices -l
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

Edit the private config with the device serial, ADB path, VW account email,
vehicle VIN, and generated API key. Use `127.0.0.1` for SSH forwarding or the
computer's Tailscale IPv4 address for tailnet access. Other bind addresses are
rejected. Enable `commandsEnabled` only when ready to operate the vehicle.
The config contains no VW password or PIN.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m vwbridge.server \
  --config ~/.config/vw-android-bridge/config.json
```

For a macOS login service, run `python3 install_service.py --config
~/.config/vw-android-bridge/config.json`. It installs the per-user LaunchAgent
`com.vwapp.android-bridge`, restarting the service after crashes. It runs when that
Mac user is logged in; this is not a system boot daemon. Startup/error logs and
the SQLite request journal live beside the config. Stop and remove the agent with
the same installer command plus `--stop`; config and journal are retained.

After code updates, restart with:

```sh
launchctl kickstart -k gui/$(id -u)/com.vwapp.android-bridge
```

## API

All endpoints require `Authorization: Bearer <apiKey>`. Transport is plain HTTP
restricted to loopback/SSH or the encrypted Tailscale network. Do not publish this
HTTP listener on the public internet. There is no generic shell, tap, screenshot,
or credential-reading endpoint.

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Device connectivity and supported capabilities; does not imply a valid VW session |
| `GET /v1/status` | Verify the signed-in account, select the configured VIN, and read the app's status and climate panel |
| `POST /v1/climate` | Set climate on/off, wait for controls to settle, and reopen the panel to verify app-reported state |
| `GET /v1/requests/<requestId>` | Retrieve a command's persisted result or its pending state |

Climate body:

```json
{
  "requestId": "a-new-uuid-for-this-intent",
  "vin": "YOUR_17_CHARACTER_VIN",
  "enabled": true
}
```

Use a new request ID for each new intent. Repeat the **same ID and same body**
after a client disconnect; completed results are returned without reissuing the
command. Reusing an ID with different parameters returns `IDEMPOTENCY_CONFLICT`.
An in-flight request interrupted by service restart becomes `OUTCOME_UNKNOWN`.
Inspect status before deciding on a new intent; never blindly generate another ID
to retry an unknown outcome. Journal rows persist until explicitly removed.

Only one UI operation runs at a time. Overlapping operations receive HTTP 409
`DEVICE_BUSY`; they are not queued. Requests continue and save their result if the
client disconnects. Allow up to 300 seconds for a command; the vehicle can take
minutes to respond. Status reads also take tens of seconds because the app is
navigated and its account and VIN are verified each time.

Example, after loading the private key into `VW_BRIDGE_KEY`:

```sh
curl --fail-with-body -H "Authorization: Bearer $VW_BRIDGE_KEY" \
  http://ibiza:8791/v1/status
```

Status is **what the app reports**, which may be cached. `observedAt` is when the
bridge read the UI. `reportedUpdatedText` is the app's displayed update label;
`capturedAt` stays null because that label does not reliably specify a full date
and timezone. `minutesToTarget` is the displayed time to `targetSoc`, not necessarily
time to a full battery. Unavailable fields are null. No forced vehicle refresh is
implemented. Climate confirmation is based on the app after its pending state
ends, not an independent physical measurement.

## Moving to another phone

1. Install the official US myVW app from Play, sign in, and complete onboarding.
2. Enable USB debugging and authorize the Mac. Do not reset or modify firmware.
3. Stop the bridge, change only `serial` in its private config, and restart it.
4. Run a status read and a supervised command/state-restoration test.

There are no Pixel-specific coordinates or firmware dependencies. Tap locations
come from the current UI hierarchy; scrolling is relative to the scroll container.
The verified app layout is English US myVW `2026.9.29-9674`. A version change
returns `APP_VERSION_CHANGED` until selectors are reviewed. Different screen sizes
and the replacement device still need validation; unsupported screens fail closed.

Existing sessions are reused. `AUTH_REQUIRED` or `PIN_REQUIRED` means a human must
complete that prompt in the app. Wrong accounts produce `ACCOUNT_MISMATCH`; the
bridge never silently logs out or replaces an account. Automatic login/account
switching is a later extension.

## Development

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

Tests cover app/element matching, ambiguous UI, redaction, unknown freshness,
authentication, request validation, busy handling, idempotency, and crash recovery.
They do not call VW or operate a vehicle.

`python3 -m vwbridge.device dump|tap|launch|text` is a local setup utility, using
`VW_ANDROID_SERIAL` and `ADB_PATH`. It is not available through HTTP. Text input is
read from stdin; diagnostic password nodes are redacted. Do not save raw UI dumps
or screenshots in the repository, because they can contain account and location data.

References: [ADB documentation](https://developer.android.com/tools/adb) and
[UI Automator](https://developer.android.com/training/testing/other-components/ui-automator).

## Verified on 2026-10-21

Pixel 8, Android 17, locked bootloader, official Play-installed US myVW
`2026.9.29-9674`. Fresh login and PIN onboarding succeeded. From another computer
over Tailscale, unauthenticated health returned 401 and authenticated status
returned 200 in approximately 40 seconds. Climate on and then off each completed
in 55 seconds, with the final state off. Replaying the on request returned its
saved result immediately. Restarting both the app and the host service preserved
the login, and a subsequent status read succeeded without re-entering credentials.
The command journal also survived the service restart. All 18 automated tests
passed locally and on the host.

This proves the status/climate path on this device and app version. Long-term
session renewal, lock/unlock, charging commands, account switching, and replacement
device behavior have not been verified.
