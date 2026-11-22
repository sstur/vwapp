# VW integrity bridge

A native Rust macOS service that supplies fresh Google Standard Play Integrity
tokens from the USB-connected, registered myVW Android app. The Cloudflare
Worker still performs VW requests directly. The HTTP API and configuration are
compatible with the former TypeScript daemon, so existing app releases work
without a backend or TestFlight update.

The executable contains the exact Frida Core library and phone-side JavaScript
agent it needs. No Node, Python, npm packages or repository checkout are needed
at runtime. The small injected agent runs in Frida's QuickJS on Android; its
strict TypeScript source lives in `../integrity-agent`. Frida itself is native C.

## Verified setup

Moto g15 power, LineageOS 23.2 / Android 16, official Google Play myVW
2026.9.29-9674 (`versionCode 1800220674`), Frida Core/server **17.22.2** and
**frida-java-bridge 7.0.13**. The phone must already satisfy VW's integrity and
licensing requirements. The agent's obfuscated class names belong to this exact
APK. Keep automatic myVW updates off until a replacement has been inspected and
verified; the version guard rejects unexpected APKs.

The service starts Frida/myVW and unfreezes the app as needed, with the screen
asleep. Cold app startup waits ten seconds before attaching, avoiding Android
16's ART collector transition. After an Android reboot, its first unlock may
still be necessary. Keep USB debugging authorized and the Mac awake.

## Build and install

Install Rust (1.88 or newer) and Xcode Command Line Tools. With Cargo on PATH,
from this directory:

```sh
cargo build --release --locked
cargo test --locked
mkdir -p ~/.config/vw-integrity-bridge
test -e ~/.config/vw-integrity-bridge/config.json || \
  cp config.example.json ~/.config/vw-integrity-bridge/config.json
chmod 600 ~/.config/vw-integrity-bridge/config.json
```

For upgrades, reuse the existing config and bearer key. For a new installation,
configure the device serial, an independent random bearer key, bind address,
working absolute ADB executable and APK details. Provision the matching
frida-server on the rooted phone and authorize ADB shell root access. Keep the
plaintext listener private; use the existing authenticated HTTPS tunnel. The
Worker's `INTEGRITY_BRIDGE_URL` and `INTEGRITY_BRIDGE_KEY` must match.

```sh
sudo ./target/release/vw-integrity-bridge install \
  --config "$HOME/.config/vw-integrity-bridge/config.json" --user "$(id -un)"
```

The installer copies the executable and verified ADB binary to a versioned,
root-owned `/Library/Application Support/VWIntegrityBridge/` directory. It
installs `/Library/LaunchDaemons/com.vwapp.integrity-bridge.plist`, running as the
specified ordinary user. `RunAtLoad` and `KeepAlive` start it at system boot and
restart it after crashes, independently of GUI login. The installer leaves
tunnel configuration alone; provision an independently supervised tunnel when
setting up a new Mac. This Mac's existing tunnel already runs as a system
LaunchDaemon. FileVault still requires unlocking the Mac's boot volume before
macOS can start services.

The installer reads the source config and copies/checks ADB as the service user,
never executing ADB as root. It leaves the source config untouched, installs a
private deployment copy, and stages backups under the root-controlled release
directory. Ownership and mode are set before publishing files. The optional
`lockDirectory` in the deployment config preserves shared device locks across
releases and canaries; it defaults to the source config's directory.

After starting the new job, a private readiness file must identify its launchd
PID and successfully bound socket. This does not send the bearer key to an
unverified listener. Failed activation restores the previous job; the old GUI
plist is left intact until success, preserving its ownership and permissions.
The tunnel is never rewritten or restarted. Readiness does not prove upstream
VW health: run the integration checks below before deleting old releases.
Reinstallation uses the same command and is independent of Homebrew Node paths.

Cargo downloads the official Frida devkit for Apple Silicon or Intel macOS on
the first build, verifies a pinned SHA-256 checksum and generates the C FFI.
Extraction is published atomically, so interrupted builds cannot reuse a partial
library. The resulting executable links only macOS system libraries/frameworks. Runtime
network access is not required for dependency installation. See `assets/` for
upstream licenses and the embedded agent's provenance.

## HTTP contract and reliability

Both routes require `Authorization: Bearer <key>` and return JSON with
`Cache-Control: no-store`:

- `GET /healthz` → `{ok:true, service:"vw-integrity", lastSuccessAt:null|epochMs}`.
  This reports listener health, not active phone availability.
- `POST /v1/integrity`, exactly `{"requestHash":"<43 base64url characters>="}`
  → `{"token":"..."}`. Each call mints a fresh token.
- Errors: 401 `UNAUTHORIZED`, 404 `NOT_FOUND`, 400 `INVALID_REQUEST`, or 503
  `BRIDGE_BUSY` / `INTEGRITY_UNAVAILABLE`, in an `{"error":"..."}` response.

A single-threaded Tokio HTTP loop stays responsive while a separate, single-use
Rust child handles ADB and native Frida. One mint is allowed at a time, protected
by a semaphore and OS file locks. A disconnected client cannot release the mint
slot early. Limits: 64 HTTP sockets, 8 KiB header buffer, 1 KiB body, five-second
header/body receipt deadlines, bounded subprocess output, and a 75-second mint
deadline. Timeout/cancellation kills the entire worker process group, including
ADB children. A watchdog removes orphaned workers when the supervisor dies;
a second worker-held lock prevents overlap during supervisor restart.

SIGTERM stops accepting requests and drains active work for up to 80 seconds;
launchd allows 90 seconds before forced exit. Native calls and their failure
modes stay outside the HTTP process. All application `unsafe` code is isolated
in `src/native.rs`, with documented pointer ownership and callback lifetimes.
Config, requests and native responses are validated at runtime. Logs contain
operation timing/success, never tokens, hashes, headers or VW credentials.

## Verification and troubleshooting

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
launchctl print system/com.vwapp.integrity-bridge
launchctl print system/com.vwapp.android-tunnel
```

On macOS, root `pnpm test` includes Rust formatting, Clippy and tests as well as strict
TypeScript checks for the app/backend and phone agent. Tests cover the HTTP
contract, authentication, malformed/slow input, concurrency, disconnected
clients, worker crashes, deadlines, process-tree cleanup, parent death and
shutdown draining and installer regressions. Other platforms explicitly skip
the macOS-only native checks. Logs live in the installed release directory;
`launchctl print` shows their paths.

A canary can use a copied private config with host `127.0.0.1` and an unused
port, started with `./target/release/vw-integrity-bridge serve --config ...`.
Keep it beside the main config so the per-device lock files are shared.

From the repository root, using the deployed Worker's RPC URL:

```sh
API_URL=https://your-worker.workers.dev/rpc node --env-file=.env \
  --env-file=backend/.dev.vars --import tsx backend/scripts/restore-smoke.ts --renew
```

This forces real OAuth/S-PIN renewal, exercises concurrent requests, and checks
status, climate settings, activity, inbox, map signing and database snapshots.
It wakes the vehicle but does not lock, unlock, charge or run climate.

If startup fails, inspect launchd state and private logs. A temporarily missing
bind address at boot is retried by launchd. For device failures first verify the
configured ADB executable with `adb version` and `adb devices -l`. On this Mac,
the Homebrew ADB file once hung in the macOS loader while an identical private
copy worked; the installer deliberately preserves a verified standalone copy.
Listener health alone does not prove the phone or VW is available.
