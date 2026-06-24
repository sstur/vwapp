// Run an eas-cli command with the real App Store Connect app id injected into
// eas.json, then restore the committed "$ASC_APP_ID" placeholder.
//
// Why this exists: EAS gives no way to supply ascAppId at invoke time — eas.json
// does not interpolate env vars, `eas submit` has no --asc-app-id flag, and a
// non-interactive submit hard-errors without ascAppId in the profile ("Set
// ascAppId in the submit profile (eas.json) or re-run in interactive mode").
// So we substitute the committed placeholder with the real value (from
// app/.env), run the command, and swap it back. Keeps the owner-specific id out
// of committed config.
//
// Both `eas build --auto-submit` and `eas submit` resolve the submit profile
// (and thus ascAppId) LOCALLY, up front, when scheduling — eas does not re-read
// eas.json during the build/upload/processing that follow. So as long as the
// command passes --no-wait, the substituted state lives only for the few seconds
// of scheduling; the build and the server-side auto-submission then run on EAS
// with no local process (you can close your laptop). Restored on every exit
// path INCLUDING termination signals, so a killed run never leaves the real id
// committed-dirty in eas.json.
//
// Usage: node scripts/with-asc-app-id.mts <command> [args...]
//   (invoked by the publish:ios / submit:ios package scripts, which source .env)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = process.argv[2];
const args = process.argv.slice(3);
if (bin === undefined) {
  console.error("usage: with-asc-app-id.mts <command> [args...]");
  process.exit(1);
}

const ascAppId = process.env.ASC_APP_ID;
if (ascAppId === undefined || !/^\d+$/.test(ascAppId)) {
  console.error(
    "ASC_APP_ID (digits only) must be set in app/.env to submit to TestFlight.",
  );
  process.exit(1);
}

const easPath = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "eas.json",
);
const original = readFileSync(easPath, "utf8");
if (!original.includes('"$ASC_APP_ID"')) {
  console.error('eas.json is missing the "$ASC_APP_ID" submit placeholder.');
  process.exit(1);
}

// Restore the committed placeholder. Idempotent + guarded so the finally and the
// signal handlers can all call it without clobbering each other.
let restored = false;
const restore = (): void => {
  if (restored) return;
  restored = true;
  writeFileSync(easPath, original);
};

// A killed run must still restore eas.json. execFileSync blocks the event loop,
// so on Ctrl+C the child dies, execFileSync throws, and the finally restores;
// these handlers cover the remaining cases (SIGTERM from a parent, SIGHUP).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    restore();
    process.exit(1);
  });
}

try {
  writeFileSync(
    easPath,
    original.replace('"$ASC_APP_ID"', JSON.stringify(ascAppId)),
  );
  execFileSync(bin, args, { stdio: "inherit" });
} finally {
  restore();
}
