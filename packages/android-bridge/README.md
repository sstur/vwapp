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
python3 -m venv ~/.config/vw-android-bridge/venv
source ~/.config/vw-android-bridge/venv/bin/activate
pip install -r requirements.txt
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
`charge` (`enabled`), `chargeLimit` (`targetSoc`, 50–100 in steps of ten),
`activity`, and `messages`. Charge-limit writes reopen battery settings after
the pending state ends and verify the saved value. Saved charging-location
settings may override this general battery limit.

Status includes the general battery target, category update labels, and parked
coordinates/address. Coordinates come from the directions intent myVW opens in
Google Maps; navigation is never started. Google Maps must be installed. The
odometer is read when visible; charging's countdown replaces it, so the cloud
retains the last reading with its original observation time. Reads never stop
charging to expose mileage.

For a validated ID. Buzz, add `"vehicleProfiles": {"YOUR_VIN": "idbuzz_2024"}`
to private config. Door/window highlights are read through deterministic pixel
comparison against the same layered artwork used by our mobile client. Bounds
come from accessibility, not device coordinates; unknown models, clipping,
ambiguous images, and layout changes report unavailable. The ordinary vehicle
photo means no openings are highlighted. Neither that photo nor an unhighlighted
door proves an individual sensor reports closed; Android clients label these
items “Not shown open”. Individual door-lock values, instantaneous charging kW,
and connector-lock state remain unknown when absent from the UI.
Charging kW needs another inspection at a fast charger: the owner has seen it in
myVW, and the initial low-power session may have hidden or rounded the reading.
See TODO.md; this is pending validation rather than a confirmed app limitation.
Live checks validated all four doors, hood, tailgate and both front windows.
Neither rear sliding-window pane produced a highlight during the ID. Buzz tests,
even after the app updated. Do not infer that either rear pane is closed.

Activity and the Messages inbox tab are read with bounded scrolling (50 items,
15 pages). Inbox reading does not open messages or change their read flags.
Synthetic content IDs are stable across refreshes. Android inbox sync preserves
existing read/delete overrides and never prunes older rows based on UI absence.
Offers are a separate stock-app tab, not part of the Messages inbox.

The service verifies the profile email, switches accounts through the app when
needed, and selects the exact VIN before each vehicle operation. It reuses the
current session. `forceLogin` in credentials is for the trusted cloud login flow
when a submitted password differs from the encrypted saved copy; ordinary jobs
must omit it. A password/PIN attempt reserves a 15-minute backoff **before typing**,
cleared after successful identity verification. A navigation failure before any
authentication begins releases its unused reservation. Credentials are held only in
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
Use the virtual environment's Python to install the LaunchAgent so Pillow is
available to the image reader. The vehicle profile is keyed by VIN and survives
a phone replacement. To run all tests, activate this environment before `pnpm
test` from the repository root.

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

## Cloud and mobile integration

In `backend/`, configure Worker secrets `ANDROID_BRIDGE_URL` (the named tunnel's
HTTPS origin) and `ANDROID_BRIDGE_KEY` (the Mac's `apiKey`). Keep the existing
`INSTANT_APP_ID`, `INSTANT_ADMIN_TOKEN`, and `CREDS_ENC_KEY`. Set the Worker variable
`VEHICLE_PROVIDER=android` to select this provider. There is no automatic fallback
to the blocked VW HTTP endpoints. The `ANDROID_GATEWAY` Durable Object binding and
SQLite migration are included in `wrangler.jsonc`.

The optional `integration` environment uses a separate Worker/coordinator with no
cron. It can share the database for supervised tests, but do not run concurrent
control tests against integration and production. They share one physical phone;
the Mac's device lock is the final concurrency boundary.

The public app RPC keeps its vehicle-level contract. Each command accepts an
optional UUID `requestId`; mobile controls generate one per user intent. Reuse
that ID after a network failure. Never generate a new ID merely to retry an
uncertain command. The coordinator persists encrypted credentials while a job is
pending, serializes operations, and admits at most three waiting interactive
requests. Background work skips a busy queue. Waiting commands expire after two
minutes without being sent. Durable alarms finish accepted work even if the app
closes; snapshots and operation progress land in InstantDB. A status read is also
the reconciliation step after an uncertain write.

The `vehicle.connection` RPC exposes account-scoped coordinator progress, queue
length, and last alarm time. The app's operation card shows a request ID on failure;
use that ID to correlate Worker logs with Mac logs/journal. An unavailable phone,
locked screen, expired login, changed myVW version, and unconfirmed vehicle command
are distinct failures. A service health response alone does not validate them.

Status polling runs every five minutes. Managed climate sessions are checked each
minute while active. These intervals include phone UI latency; this is not a
real-time transport. Keep the phone connected, charged, online, and unlocked.
A person must handle any secure lock, new USB authorization, or unexpected MFA.
The bridge does not weaken the phone's lock settings.

Run the cloud smoke test (only on your own vehicle/account):

```sh
cd backend
API_URL=https://YOUR-WORKER.workers.dev/rpc \
  node --env-file=../.env --env-file=.dev.vars scripts/android-smoke.ts
```

Adding `--controls` starts climate briefly, checks duplicate-request replay, and
restores climate off in `finally`; it requires climate initially off and a known
setpoint. It verifies cloud login, phone status, and the resulting database rows
without logging credentials or VINs. The mobile app ships through a native
TestFlight build, as required by the repository's release workflow.

### Replacement phone checklist

1. Install official US myVW from Play; allow required permission/onboarding prompts.
2. Enable USB debugging, attach it, and authorize this Mac. Read `adb devices -l`.
3. Wait for `/v2/health` to show no active request. Change only `serial` in the
   private Mac config, then restart the bridge LaunchAgent. Keep the API key,
   tunnel, and journal intact; no cloud/mobile endpoint change is needed.
4. Run a cloud login and status read. The cloud supplies the stored credentials;
   validate the account and vehicle shown on the replacement phone.
5. Validate a supervised reversible command and restore its prior state. A new
   myVW version may require a reviewed selector profile before controls work.

For a rollback, disable commands in the Mac config and restart the bridge after
any active job finishes. Do not reset the journal or replay an uncertain write.
Reverting `VEHICLE_PROVIDER` restores the old direct implementation, whose VW
integrity limitation still applies; it is not a working emergency fallback.

## Validation record

Validated on 2026-10-21 with the stock Pixel 8 and the supported myVW version:
account verification and automatic sign-in from the logged-out screen; status;
lock/unlock; climate on/off and setpoint changes; charging stop/start; authenticated
cloud transport; duplicate intent replay; and InstantDB updates visible in the
custom iOS app. A 20-second tunnel outage during an app-initiated refresh produced
retriable transport errors, then completed the same phone job exactly once.

The restored features also passed the authenticated cloud API: battery limit
100% → 90% → 100% with a final read confirming restoration; 28 activity entries;
seven inbox messages with existing local read/deletion overrides preserved;
parked coordinates/address; retained mileage with its observation time; and all
four vehicle-update labels. Physical checks validated both front doors, both
sliding doors, tailgate, hood, and both front windows against the graphic reader.
Neither rear-window opening appeared in myVW after its reported update advanced.
The mobile changes shipped in TestFlight 1.0.26 (30).

The Mac service also restarted with its journal retained and with no account email
or VIN in its host configuration. Vehicle state at the end of command testing was
charging, climate off at 72°F, and locked on later reads after the unlock test. These are myVW observations, not physical telemetry
independently measured by this service.

Multi-account switching is implemented, but only one real VW account was available
for live validation. The replacement Android device still needs its own validation.
