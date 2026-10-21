# myVW Android bridge

A deterministic service controlling the official US myVW Android app over USB.
No root, app patch, injected code, VW HTTP client, or AI agent runs on the phone.

The cloud Worker authenticates the mobile user, retrieves their encrypted VW
credentials, and sends a vehicle intent to a durable cloud coordinator. The
coordinator submits a short HTTPS request through a named Cloudflare Tunnel to
this service, then polls the job. Results update InstantDB and stream to the app.
Neither a mobile disconnect nor a tunnel timeout reissues an accepted command.

## Host setup

Python 3.10+ and Android platform tools are required. On macOS:

```sh
brew install --cask android-platform-tools
brew install cloudflared
mkdir -p ~/.config/vw-android-bridge
chmod 700 ~/.config/vw-android-bridge
cp config.example.json ~/.config/vw-android-bridge/config.json
chmod 600 ~/.config/vw-android-bridge/config.json
adb devices -l
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

Set `serial`, `adb`, `apiKey`, and the bind address in the private config. Use
loopback with a local tunnel, or the Mac's Tailscale IPv4. Enable `commandsEnabled`
when ready. No VW email, VIN, password, or PIN is needed in the v2 host config.
Install US myVW from Google Play and authorize USB debugging. Initial permission
and onboarding screens may need a person. Keep the device unlocked; the bridge
wakes the screen but does not bypass its secure keyguard or change system settings.

```sh
python3 install_service.py --config ~/.config/vw-android-bridge/config.json
python3 install_tunnel.py --token-file ~/.config/vw-android-bridge/tunnel-token
```

The tunnel token file must have mode 600. Configure a **named** Cloudflare Tunnel
with the chosen hostname pointing to the service, plus a final `http_status:404`
ingress rule, and a proxied CNAME to `<tunnel-id>.cfargotunnel.com`. The two macOS
LaunchAgents restart after crashes and at user login. They are not boot daemons;
FileVault/login and a locked phone still require physical access after a reboot.

After updating code:

```sh
launchctl kickstart -k gui/$(id -u)/com.vwapp.android-bridge
```

Use the installers' `--stop` flag to remove their LaunchAgents. Private config and
state are retained. Do not delete the journal to retry an uncertain command.

## API v2

Every endpoint requires `Authorization: Bearer <apiKey>` (a random 256-bit-or-more
key). The Worker stores its copy as a secret; the mobile app never receives it.
Public transport must be HTTPS. There are no generic shell/tap/screenshot APIs.
Bodies are bounded; only one phone operation can execute at a time.

- `GET /v2/health`: service version, active request, last job, command enablement.
  This is service liveness, **not** proof of an unlocked phone or working VW login.
- `POST /v2/jobs`: validate, persist admission, return 202 immediately. A busy
  phone returns `DEVICE_BUSY` without reserving the ID; retry the same request.
- `GET /v2/jobs/<requestId>`: `running`, `succeeded` with `result`, or `failed`
  with `error: {code, message, retryable}`. Requires the same service key.

Example body (secrets shown only as placeholders):

```json
{
  "requestId": "a-unique-uuid-for-this-intent",
  "operation": "climate",
  "credentials": {
    "username": "owner@example.com",
    "password": "...",
    "spin": "1234"
  },
  "vin": "YOUR_17_CHARACTER_VIN",
  "params": { "enabled": true, "tempF": 72 }
}
```

Operations: `session` (VIN null, returns visible garage vehicles), `status`,
`climateInfo`, `climate` (`enabled`, optional `tempF`), `lock` (`locked`), and
`charge` (`enabled`). `chargeLimit` currently returns `UNSUPPORTED_OPERATION`;
this stock-app layout has no validated charge-limit UI. Activity, inbox sync,
detailed closures, odometer, and location coordinates are not implemented.

The service verifies the profile email, switches accounts through the app when
needed, and selects the exact VIN before each vehicle operation. It reuses the
current session. `forceLogin` in credentials is for the trusted cloud login flow
when a submitted password differs from the encrypted saved copy; ordinary jobs
must omit it. A password/PIN attempt reserves a 15-minute backoff **before typing**,
cleared only after successful identity verification. Credentials are held only in
memory for that job and never written to the journal/logs. Arbitrary Unicode
credentials and literal `%s` are rejected before logout because ADB's text input
cannot reliably enter them. MFA/CAPTCHA/unknown onboarding returns a human-action
error rather than guessing through an authentication screen.

### Idempotency and recovery

Keep the same request ID and identical parameters after a lost response. A
completed result returns immediately; an in-flight duplicate observes the same
job; changed parameters return `IDEMPOTENCY_CONFLICT`. SQLite stores keyed request
fingerprints and results, **not credentials**. A crash marks unfinished jobs
`OUTCOME_UNKNOWN`. A subsequent status read must reconcile an uncertain vehicle
before another write is accepted. Commands are never blindly retried.

UI selection is by package, exact resource IDs/text, and unique visible bounds.
Reads tolerate transient UI-dump failures; taps never auto-retry. Scroll distances
are relative to the identified container. Unknown/ambiguous screens fail closed.
Each job has an eight-minute execution budget; command confirmation has shorter
bounded waits. A VW failure, disconnect, locked screen, version change, and
uncertain command produce distinct error codes.

The supported selector profile is English US myVW `2026.9.29-9674`. An app update
returns `APP_VERSION_CHANGED` until its layout is reviewed. The verified device
is a stock Pixel 8 running Android 17; no device-specific coordinates are used.
A replacement phone needs Play installation, USB authorization, a serial config
change, and validation. Login credentials will come from the cloud on demand.

### Data semantics

Status is what **myVW displays**, which may be cached. `observedAt` is the UI-read
time; `reportedUpdatedText` preserves myVW's label. `capturedAt` is null because
the label does not identify a reliable date/timezone. Missing telemetry remains
unknown. `minutesToTarget` refers to the selected charging limit, not necessarily
100%. Command verification is app-reported state after its pending state ends,
not an independent physical measurement. No force-refresh/wake command is claimed.

### Diagnostics

`~/.config/vw-android-bridge/state/events.jsonl` contains rotated structured logs
(request ID, operation, result, error code, duration). The SQLite journal lives in
the same private directory. Service and tunnel startup logs live beside the config.
Logs do not include credentials, raw UI, account email, or VIN. The config folder
must remain private; job results themselves contain vehicle data.

Legacy `/v1/status`, `/v1/climate`, `/v1/requests/<id>` remain for the original
prototype only when a username/VIN is configured. New integrations use v2.

## Development

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

Tests cover safe selectors, command validation, private credentials, concurrency,
idempotency, durable login backoff, and crash recovery. Local setup utility:
`python3 -m vwbridge.device dump|tap|launch|text`, using `VW_ANDROID_SERIAL` and
`ADB_PATH`. Text comes from stdin. Do not save raw screenshots/hierarchies in git.

See [ADB](https://developer.android.com/tools/adb),
[UI Automator](https://developer.android.com/training/testing/other-components/ui-automator),
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/),
and [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).
