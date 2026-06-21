# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Personal app to monitor and (eventually) control the owner's 2025 VW ID. Buzz
by talking to VW's servers the way the stock myVW app does. It is an
independent re-implementation of VW's official **myVW** iOS app
(<https://apps.apple.com/us/app/myvw/id1481486650>) — it speaks the same VW
backend protocol (reverse-engineered from that app; see *VW protocol* below)
rather than reusing any of its code. Planned/agreed future work lives in
**TODO.md** — check it before designing anything new.

## Commands

```bash
pnpm test                 # typecheck + lint, all packages (run before committing)
pnpm --filter @vwapp/backend dev          # Worker on localhost:8787
pnpm --filter @vwapp/mobile start         # Expo (app expects Worker on :8787 unless EXPO_PUBLIC_API_URL set)
```

**Deployable by anyone (no owner values committed):** every account/identity
value comes from gitignored env files created from the `*.example` templates
(root `.env`, `backend/.dev.vars`, `app/.env`) — see README "Deploy your own
instance". `backend/wrangler.jsonc` pins **no** `account_id`; deploy targets your
account via `CLOUDFLARE_ACCOUNT_ID` in the environment. Apple Maps is optional
(see *Data freshness* / `isMapsConfigured`).

**Production Worker:** deployed as `vwapp-api` from `backend/` with
`pnpm --filter @vwapp/backend deploy` (the `deploy` script sources
`backend/.env` for `CLOUDFLARE_ACCOUNT_ID` so wrangler targets your account) →
`vwapp-api.<your-subdomain>.workers.dev`. Prod shares dev's InstantDB app +
`CREDS_ENC_KEY` (secrets = `.dev.vars`, pushed via `wrangler secret bulk`), so
the cron polls VW for real every minute once deployed.

**Publishing the app (EAS Update → Expo Go):** owner-specific Expo config is
env-driven via `app/app.config.ts` (which augments the generic `app.json`):
`EXPO_OWNER`, `EAS_PROJECT_ID` (→ `extra.eas.projectId` + the `updates.url`), and
`IOS_BUNDLE_IDENTIFIER`. Publish with `pnpm --filter @vwapp/mobile update --
--message "..."` — the `update` script sources `app/.env` first because
`eas-cli`'s project resolver reads `EAS_PROJECT_ID` from the real shell env, not
from the dotenv-loaded config (`expo` does load it, `eas` does not). The API URL
is resolved at runtime in
`app/src/rpc.ts`: explicit `EXPO_PUBLIC_API_URL` (required for published builds)
→ else Metro dev-server host (port 8787; works for simulator and LAN devices —
`dev:worker` binds 0.0.0.0 for this) → else it throws (no hardcoded prod
fallback). Keep `runtimeVersion: {policy: "sdkVersion"}` — Expo Go can only load
updates whose runtime is its own SDK (`exposdk:56.0.0`).

Backend scripts (run from `backend/`, plain Node ≥24 runs the TS directly):

```bash
node --env-file=../.env --env-file=.dev.vars scripts/smoke.ts   # end-to-end vs running Worker, real VW login
node --env-file=.dev.vars scripts/auth-check.ts                 # auth plumbing only, no VW traffic
node --env-file=.dev.vars scripts/wipe.ts                       # delete ALL InstantDB rows + users
npm run status            # from packages/poc — direct VW status check, no Worker needed
```

InstantDB schema/perms changes: edit `packages/db/src/index.ts` (and
`backend/instant.perms.ts`), then from `backend/`:

```bash
set -a && source .dev.vars && set +a && npx instant-cli push schema --yes  # or: push perms
```

(instant-cli reads env vars, not `.dev.vars`, hence the sourcing.)

Crons never fire on a clock in dev; wrangler only exposes
`http://localhost:8787/cdn-cgi/handler/scheduled` (always on, no flag — the
older `--test-scheduled`/`__scheduled` is wrangler v3). `pnpm dev` therefore
runs `dev:worker` (wrangler) and `dev:cron` (a curl loop ticking that endpoint
every 60s) concurrently via pnpm's regex script runner; curl it manually for a
one-off tick.

## Architecture and the intent behind it

pnpm monorepo: `app/` (Expo SDK 56 + expo-router + Tamagui, runs in Expo Go),
`backend/` (Cloudflare Worker, oRPC), `packages/contract` (oRPC contract),
`packages/db` (shared InstantDB schema), `packages/poc` (throwaway reference
implementation of the VW protocol — relaxed lint, don't hold it to repo standards).

**Hybrid InstantDB design (deliberate):** the Worker's admin SDK is the *only
writer*; the app reads `vehicles`/`snapshots` directly via Instant live
queries (`db.useQuery`) and gets real-time updates — no client polling, no
cache invalidation for data. React Query is used *only* for RPC calls
(`login`/`logout`/`me`/`refresh`). `vwAccounts` (AES-GCM-sealed VW credentials
+ tokens) is deny-all by permission; never expose it to clients or move VW
calls client-side.

**Identity:** Instant guest auth. The app calls `db.auth.signInAsGuest()` once;
RPCs carry the guest refresh token, which the Worker verifies via
`db.auth.verifyToken()`. Data is keyed to Instant's built-in `$users` — there
is no custom user/device-token scheme (there used to be; it was removed).
**One VW session, many clients:** `vwAccounts` holds THE single VW session
per VW account (unique `userKey` = sha256 of the normalized username);
vehicles/snapshots hang off the account, not the user. Logging in converges
onto that row — so the app, a second device, and `smoke.ts` can all be
"logged in" at once without duplicate sessions, and the cron polls VW once
per account. Login is **compare-first**: if the submitted password matches
the stored copy (digest compare) and the saved tokens still work against VW
(garage call, refresh if needed), the client attaches with NO VW password
login — only a mismatch or dead session triggers the real (throttled) login. Logout merely
detaches the client — the session deliberately persists even with zero
clients, so server-side automation (the cron; future user schedules like
timed climate) can keep authenticating with VW. Deleting a session is an
explicit act (`scripts/wipe.ts`, or a future account-removal feature), never
a logout side effect.

**Data freshness:** a Wrangler cron (`* * * * *`, every minute — Cloudflare's
finest; `backend/src/poll.ts`) polls VW per stored account and writes snapshots
(deduped on VW's `capturedAt`, pruned after 30 days). Plain `rvs`/`ev` reads
aren't the tsp-token-rate-limited endpoints, so 1-min polling is safe. Pull-to-refresh is the `vehicle.refresh` RPC; its result also
arrives via the snapshot live query. Per-user schedules must NOT become
Wrangler crons — see TODO.md §2. Cold-start coverage (don't remove either
half): `auth.login` writes initial snapshots after storing creds, and the
dashboard auto-fires one `vehicle.refresh` when a vehicle has no snapshot
(plus an explicit empty-state card) — crons never fire on a clock in dev, so
without these a fresh login would show a blank dashboard.

**VW integration — critical constraint:** the account is **North America
(myVW / legacy Car-Net)**: host `b-h-s.spr.us00.p.con-veh.net`, identity
`identity.na.vwgroup.io`. Do NOT use the EU CARIAD stack
(`emea.bff.cariad.digital`, `identity.vwgroup.io`) — it answers "wrong email
or password" for this account. VW throttles after ~8–10 password logins in
quick succession; `backend/src/tokens.ts` exists to make full logins rare
(reuse access token → refresh → password login only as last resort). Space out
any testing that triggers real logins. The login flow is an HTML scrape
(fragile by nature); `packages/poc/src/vwClient.ts` is the verified reference.
Full flow, constants, endpoints, and how we found the right VW backend are in
**VW protocol** below.

## VW protocol (North America Car-Net)

**How we landed on this stack.** The owner's myVW iPhone login showed
`identity.na.vwgroup.io` ("Volkswagen of America"); decompiling the US **myVW**
Android APK (`com.vw.carnet.release`) confirmed it talks to the **legacy
Car-Net** cluster `b-h-s.spr.us00.p.con-veh.net` with a `kombi:///` redirect.
There are three distinct VW backends and only this one works for this account:
the **EU CARIAD** stack (`emea.bff.cariad.digital` / `identity.vwgroup.io`,
client `a24fba63…`, whose implicit/hybrid grant is now disabled anyway) answers
"wrong email or password"; the **NA CARIAD** stack (`na.bff.cariad.digital`,
client `3ad74830…`) is a valid client but no shipping app uses it and we never
recovered its redirect_uri. Don't chase either — use legacy NA.

**Auth** = OAuth2 **authorization-code + PKCE (S256)**, public client, **no
client secret** (constants are identical at the top of
`packages/poc/src/vwClient.ts` and `backend/src/vw/client.ts`):

1. `GET {API}/oidc/v1/authorize` with device client
   `59992128-…_MYVW_ANDROID`, `redirect_uri=kombi:///login`, `scope=openid` →
   302 to the IdP.
2. Identifier-first HTML login on `identity.na.vwgroup.io` (browser IdP client
   `b680e751-…@apps_vw-dilab_com`): scrape the email page, then the password
   page (`_csrf`, `relayState`, `hmac` hidden fields), POSTing to
   `/signin-service/v1/{IDP_CLIENT}/login/{identifier,authenticate}`.
3. Follow redirects to `kombi:///login?code=…`; exchange at
   `{API}/oidc/v1/token` (`grant_type=authorization_code`, `code_verifier`) →
   access / refresh / id tokens.

**Status** (Bearer access token; vehicles are addressed by **UUID, not VIN**):

- `GET /account/v1/garage` → vehicles (`vehicleId`/`uuid`, `vin`, nickname, model).
- `GET /rvs/v1/vehicle/{uuid}` → lock (`exteriorStatus.secure === "SECURE"`),
  range (`powerStatus.cruiseRange` + `cruiseRangeUnits`), odometer
  (`currentMileage`, km).
- `GET /ev/v1/vehicle/{uuid}/charge/summary` → **SoC**
  (`batteryStatus.currentSOCPct` — *not* on RVS), charge state
  (`chargingStatus.currentChargeState`, e.g. `chargingHVBattery`), plug
  (`plugStatus`), target SoC. Distances are normalized to km in
  `toStatusDTO`; the app converts to miles (`app/src/units.ts`).

**Write-commands** (lock/unlock) — VERIFIED LIVE 2026-06-09, reproduced in
`packages/poc/src/lock-poc.ts` (`pnpm --filter @vwapp/poc lock [lock|unlock]`).
`userId` is the `sub` claim of the id_token (decode the JWT; no endpoint). The
S-PIN (`VW_PIN` in `.env`) gates the command via a per-vehicle token:

1. `GET /ss/v1/user/{userId}/challenge` → `data.challenge`, `data.remainingTries`
   (bail if `< 3` to avoid an S-PIN lockout). **GET, not POST** (POST → 405).
2. `spinHash = sha512(`​`${challenge}.${spin}`​`)`, **lowercase** hex.
3. `POST /ss/v1/user/{userId}/vehicle/{uuid}/session` body
   `{idToken, spinHash, tsp:"WCT"}`, **Bearer = access_token** (the id_token
   goes in the body, not the header — server rejects id_token-as-bearer with
   `jtt must be 'access_token'`) → `data.carnetVehicleToken` (a JWT, reusable
   for several commands in a short window).
4. **`PUT /lockunlock/v1/vehicle/{uuid}`** with **`Authorization: Bearer
   <carnetVehicleToken>`** (the S-PIN token IS the bearer — *not* the access
   token, and there is **no** `X-*` spin header) and body **`{"lock": true}`
   to lock / `{"lock": false}` to unlock** → `200 {data:{result:0,
   correlationId}}`. `result:0` only means **accepted/queued** — the car may
   still reject it. To confirm completion (what the stock app does, and what
   `vwAwaitCommandResult` does), poll **`GET /history/v1/vehicle/{uuid}/correlationId/{correlationId}/ro/`**
   (read auth = access token). Its `responseBody` is a JSON *string*: while
   queued it's just request metadata; once executed it gains
   `eventStatus.{responseStatus, responseCode}` (`responseStatus: 1` /
   `responseCode` containing `SUCCESS` = done, e.g. `"4101 : RO_DOOR_SUCCESS"`;
   ~6s after the command). `vehicle.command` polls this before resolving, so the
   app's button stays busy until the car truly finishes (or surfaces a failure).

**Body is `{lock: boolean}`, NOT `{action: ...}`** — verified by decompiling the
myVW APK (jadx → `defpackage/mbg.java`, `commands/models/LockAndUnlock.java`).
VW silently ignores an unknown `action` field, so the earlier `{action:"unlock"}`
never actually unlocked (it no-op'd; `{action:"lock"}` only worked incidentally).
Both directions confirmed live on the car. The OSS references are unreliable here
(matpoulin leaves lock unimplemented; its-me-prash's Bruno specs use the wrong
method, hash, and an `X-Spin-Session` header that doesn't exist in the app).
Other commands (charge start/stop, pretripclimate) are plain
`POST /ev/v1/vehicle/{uuid}/...` and need no S-PIN token. Implemented in
`backend/src/vw/client.ts` `vwLockUnlock` + the `vehicle.command` RPC; the app's
`LockControl` drives it.

**Force-refresh / wake** (VERIFIED LIVE 2026-06-10, `vwForceRefresh`) — same
S-PIN/carnet-bearer machinery: `POST /rvs/v1/vehicle/{uuid}/refresh`,
`Authorization: Bearer <carnetVehicleToken>`, no body → `200 {data:{result:0}}`.
(Access-token bearer → 403 `USER_NOT_AUTHORIZED`; the old iOS
`mps/.../status/fresh` path 404s — modern accounts are UUID-only.) It wakes the
car to report fresh telemetry, asynchronously (~10–60s). `vehicle.refresh` fires
it best-effort (`tryWakeVehicle`, silent fallback to the cloud read on any
failure); the fresh snapshot arrives via the cron + live query, not the RPC
return. So pull-to-refresh genuinely pokes the car rather than re-reading VW's
cache. APK refs: iface `defpackage/gig.java` (`@eta`=POST), interceptor
`defpackage/xfg.java`.

## Testing with real VW credentials (.env)

Root `.env` holds the owner's **real myVW login** (`VW_USERNAME`,
`VW_PASSWORD`, `VW_PIN`) — gitignored; never echo or log the password. It's
used two ways, and **both perform real VW password logins** (mind the throttle
— space them out, prefer the one-login PoC/smoke path over repeated app logins):

- **PoC / smoke:** `packages/poc` `npm run status` and `backend/scripts/smoke.ts`
  log in directly with these creds.
- **Simulator app tests:** when verifying the app in Expo Go on the iOS
  simulator via the `agent-device` CLI, type these creds into the login screen.

**agent-device gotchas** (learned the hard way):

- Load fresh JS by fully restarting Expo Go:
  `xcrun simctl terminate <udid> host.exp.Exponent`, then
  `agent-device open "exp://<lan-ip>:8081"`. Re-opening alone reuses the cached
  bundle and `metro reload` is unreliable.
- Dismiss the Expo dev-menu overlay first (Continue / Close).
- Secure-field fill is finicky: the password `Input` needs
  `autoCapitalize="none"`/`autoCorrect={false}`, and verify the typed length
  before submitting (fill occasionally adds a stray char). Submit via the
  keyboard **"go"** key (`onSubmitEditing`) — the Sign-in button gets pushed
  under the keyboard once an error line appears.
- A native "Save Password?" sheet pops after submit — dismiss with "Not Now".
- Expo Go ignores simulator appearance changes for the embedded app, so system
  light/dark can't be toggled there — hence the in-app theme toggle.
- Synthetic pan can't trigger iOS native pull-to-refresh; verify the refetch
  via the menu "Refresh" instead. Why: on iOS `swipe` durations are clamped to
  16–60ms (always a fast flick) and `gesture pan`'s durationMs is the
  **pre-drag hold**, not travel time — there is no slow-drag primitive.
- A gesture command reporting success only means events were synthesized, not
  that the app reacted. Verify through app state (snapshot diff, logs, the RPC
  firing), never through the command result.
- Before any scroll/collapse test, check the snapshot's
  "Vertical scroll bar, N pages" line. "1 page" means zero scroll range:
  drags only rubber-band and spring back before a post-gesture screenshot can
  see them (looks exactly like "drags don't work"), and large-title collapse
  can't be exercised until content exceeds one screen.
- Transient UI (rubber band, refresh spinner) outlives neither the gesture nor
  the screenshot latency. To capture it, `record start`, wait a beat for
  capture to spin up, then gesture — or repeat the gesture with
  `swipe --count N --pattern ping-pong` inside the recording window.

## Conventions and gotchas

- Strictest TS everywhere (`@tsconfig/strictest` + `noUncheckedIndexedAccess`
  etc.) + typescript-eslint strictTypeChecked. The `tx()` helper in
  `backend/src/store.ts` exists because Instant's tx proxy is typed
  possibly-undefined under these flags — use it rather than `!`.
- All `@instantdb/*` packages must resolve the **same** `@instantdb/core`
  version, or schema types silently degrade to `{}` across the workspace
  duplicate. Keep versions pinned in lockstep.
- Instant's `db.useQuery(null)` (skipped query) reports `isLoading: true`
  forever — never gate UI on a skipped query's `isLoading` (see the dashboard's
  snapshot query for the pattern).
- Tamagui: use semantic tokens (`$color`, `$background`, `$color2`,
  `$borderColor`) — not the numbered scale inside Card/Button sub-themes.
  Never branch styles on light/dark; runtime theme switches go through the
  dynamic `<Theme name>` wrapper in `theme-provider.tsx` — mutating
  `TamaguiProvider defaultTheme` propagates only partially (memoized component
  text keeps the old theme's color). For native RN components needing a real
  color string, resolve with `useTheme().color.val`. Config uses v4 shorthands
  (`bg`, `px`, `rounded`, `items`, `justify`).
- Tamagui Sheet: use fixed percent `snapPoints`, not `snapPointsMode="fit"` —
  fit's first-open measurement intermittently resolves to zero, leaving the
  sheet mounted but off-screen (a silently-dead menu).
- Native iOS UI (@expo/ui SwiftUI islands + expo-symbols + Stack.Toolbar; all
  work in Expo Go on SDK 56): every @expo/ui component sits in a `Host` that
  MUST get `colorScheme={pref}` (resolved from `useThemeToggle()`) or it
  follows system appearance, which the in-app theme override — and Expo Go —
  ignore. Give Hosts inside sheets explicit sizes (the wheel DatePicker gets
  height 216); `matchContents` is fine outside them. SF Symbols go through
  `components/sf-icon.tsx`, which resolves Tamagui tokens AND unwraps the
  theme *Variable object* (not a string) that Tamagui Button's icon-cloning
  injects as `color` — passing `SymbolView` straight into `Button icon` crashes
  with Hermes' "undefined is not a function". Don't port the climate sheet to
  @expo/ui `BottomSheet`: `fitToContents` measures auto-wrapped RN children as
  zero height (sheet presents invisibly) and the zero-size anchor Host knocks
  sibling buttons out of the accessibility tree — verified live; keep Tamagui
  Sheet for RN-content sheets.
- Env layout (real files all gitignored; each has a committed `*.example`
  template — see README "Deploy your own instance"): root `.env` = the owner's
  **real** myVW credentials (`VW_USERNAME`, `VW_PASSWORD`, `VW_PIN`) — used by
  the PoC and to drive simulator login tests; see *Testing with real VW
  credentials*. `backend/.dev.vars` = `INSTANT_APP_ID`, `INSTANT_ADMIN_TOKEN`,
  `CREDS_ENC_KEY`, and **optionally** the Apple Maps Web Snapshot signing keys
  `APPLE_MAPS_TEAM_ID` / `APPLE_MAPS_KEY_ID` / `APPLE_MAPS_PRIVATE_KEY` (the
  `.p8` PEM, used by `src/maps.ts` to sign the parked-location snapshot URL —
  when absent, `isMapsConfigured` is false and `vehicle.parkedMapUrl` returns
  `{url: null}`, so the app shows coordinates only). `backend/.env` =
  `CLOUDFLARE_ACCOUNT_ID` (deploy-time only, not a Worker secret; auto-sourced by
  the `deploy` script). `app/.env` =
  `EXPO_PUBLIC_INSTANT_APP_ID` + `EXPO_PUBLIC_API_URL` (both bundled; recreate
  per clone) and the config-time-only `EXPO_OWNER` / `EAS_PROJECT_ID` /
  `IOS_BUNDLE_IDENTIFIER` read by `app/app.config.ts`.
- Routes live in `app/src/app/` only; providers/utilities stay outside it.
  Kebab-case filenames.
