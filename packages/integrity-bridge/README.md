# VW integrity bridge

The Worker calls VW directly. This small Mac service supplies fresh Standard
Play Integrity tokens from the USB-connected, registered myVW Android app.
There are no taps, screenshots, credentials, VW sessions, or vehicle commands in
this service. Only a padded base64url SHA-256 request hash crosses the bridge.

## Verified setup

Moto g15 power, LineageOS 23.2 / Android 16, official Google Play myVW
2026.9.29-9674 (`versionCode 1800220674`). The phone must already pass VW's Play
Integrity/licensing requirements. Python 3.13, Frida/server 17.22.2,
frida-tools 14.11.0, **frida-java-bridge 7.0.13**. Earlier Java bridges crash or
cannot locate ART methods on Android 16. The agent uses obfuscated names from
this exact APK: an app upgrade requires inspecting and updating the agent.
The version guard fails closed on unexpected APKs. Keep automatic myVW updates
off until a replacement version has been verified.

## Install

From this package directory, after `pnpm install` at repository root:

```sh
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
pnpm build
mkdir -p ~/.config/vw-integrity-bridge
cp config.example.json ~/.config/vw-integrity-bridge/config.json
chmod 600 ~/.config/vw-integrity-bridge/config.json
```

Set the ADB serial, an independent random bearer key, and reachable bind address
in the private config. Provision the matching frida-server on the rooted phone
at the configured path and grant its ADB shell root access. The bridge starts
Frida/myVW and unfreezes the app when needed; the screen can remain asleep.

```sh
python3 scripts/install-service.py --config ~/.config/vw-integrity-bridge/config.json
pnpm test
```

The per-user LaunchAgent restarts on crashes and login. After a Mac reboot the
user must log in; after a phone reboot, Android may need its first unlock before
Play Services is usable. Keep the Mac awake and the phone connected/authorized.
Use the existing authenticated HTTPS tunnel to the configured private address;
do not expose the plaintext listener directly to the Internet. Set the Worker's
`INTEGRITY_BRIDGE_URL` and `INTEGRITY_BRIDGE_KEY` secrets to match.

## Protocol and operation

Both routes require `Authorization: Bearer <key>`:

- `GET /healthz`: service status and last successful mint time (not an active
  phone check).
- `POST /v1/integrity`: exactly `{"requestHash":"<44-character padded hash>"}`;
  returns `{"token":"..."}` with `Cache-Control: no-store`.

Each call creates a fresh token. Requests are serialized; a busy or unavailable
phone fails with 503. A child-process timeout bounds hung Frida/Google tasks.
The Worker serializes refreshes across all clients and handles retry backoff.
Tokens, hashes and bearer headers are never written to service logs. Logs live
beside the private config. Do not commit config, tokens, or captured phone data.

```sh
launchctl print gui/$(id -u)/com.vwapp.integrity-bridge
```

The current installation reuses the former Android bridge's Cloudflare tunnel,
but the old UI bridge LaunchAgent is disabled. Its old endpoints are absent.

## Verification commands

From `backend/`, with local or deployed `API_URL`:

```sh
node --env-file=../.env --env-file=.dev.vars --import tsx scripts/restore-smoke.ts --renew
```

This attaches a disposable test client to the existing shared VW session,
forces OAuth and S-PIN cache expiry, exercises concurrent requests, then checks
status, climate settings, activity, inbox, map signing and database snapshots.
It wakes the vehicle but does not lock, unlock, charge or run climate.
`scripts/command-verify.ts` separately performs a real brief climate start/stop
cycle and must only be run when that physical action is intended.

Cold launch waits ten seconds before Frida attaches, allowing Android 16's ART
collector startup transition to finish. Verified with both the app and Frida
stopped, the screen asleep, and renewal initiated through the deployed Worker.
