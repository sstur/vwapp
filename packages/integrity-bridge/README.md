# VW integrity bridge

The Worker calls VW directly. This small Mac service supplies fresh Standard
Play Integrity tokens from the USB-connected, registered myVW Android app.
The service and injected agent are strict TypeScript. Node.js runs the HTTP
listener, ADB recovery and the official Frida Node bindings; esbuild bundles the
agent for the phone's Frida runtime. There is no Python runtime or Python CLI in
the application build or service. Frida itself is a native dependency.

There are no taps, screenshots, credentials, VW sessions, or vehicle commands in
this service. Only a padded base64url SHA-256 request hash crosses the bridge.

## Verified setup

Moto g15 power, LineageOS 23.2 / Android 16, official Google Play myVW
2026.9.29-9674 (`versionCode 1800220674`). The phone must already pass VW's Play
Integrity/licensing requirements. Node.js 24, Frida Node bindings/server
**17.22.2**, **frida-java-bridge 7.0.13**. Earlier Java bridges crash or
cannot locate ART methods on Android 16. The agent uses obfuscated names from
this exact APK: an app upgrade requires inspecting and updating the agent.
The version guard fails closed on unexpected APKs. Keep automatic myVW updates
off until a replacement version has been verified.

## Install

From this package directory, after `pnpm install` at repository root:

```sh
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
pnpm install-service --config ~/.config/vw-integrity-bridge/config.json
pnpm test
```

The installer validates the config, pins the current Node executable in the
LaunchAgent, checks listener health, and attempts to restore the prior job if
startup fails. `pnpm install` permits Frida's native installation script via the
workspace's `onlyBuiltDependencies`. On this Mac it installs a prebuilt binary;
a platform without one may need Frida's upstream native build prerequisites.

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

Each call creates a fresh token. Only one mint may run; overlapping requests
immediately receive 503 `BRIDGE_BUSY`. An unavailable phone returns 503
`INTEGRITY_UNAVAILABLE`. Each mint runs in its own Node process, with a 75-second
deadline that kills its entire process group, including any ADB subprocess.
The HTTP listener remains responsive during minting. Request bodies are capped
at 1 KiB and have a five-second receipt deadline; requests and responses are
validated at runtime. Config and Frida RPC data are also validated. APK members
are dynamically resolved through checked `unknown` values in the agent; no
`any`, unchecked type assertions or relaxed lint rules are used in bridge code.
The Worker serializes refreshes across all clients and handles retry backoff.
Tokens, hashes and bearer headers are never written to service logs. Logs live
beside the private config (`com.vwapp.integrity-bridge.log` and
`com.vwapp.integrity-bridge-error.log`). Do not commit config, tokens, or captured
phone data.

```sh
launchctl print gui/$(id -u)/com.vwapp.integrity-bridge
```

The current installation reuses the former Android bridge's Cloudflare tunnel,
but the old UI bridge LaunchAgent is disabled. Its old endpoints are absent.

## Verification commands

From the package directory, `pnpm test` covers the HTTP contract, native-response
validation, concurrency, bounded child processes (including descendant cleanup),
APK guards and cold/frozen-device recovery. `pnpm build` typechecks both Node and
Frida targets using the repository's strictest TypeScript settings. Root
`pnpm test` includes the bridge's typechecking, strict typed lint and formatting.

For a staging service, copy the private config to a new private file, choose an
unused loopback port, and run `pnpm start --config /absolute/path/to/config.json`.
The installer also supports `--label com.vwapp.integrity-bridge-canary`. Keep
staging requests sequential with production: both services share one phone.

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
