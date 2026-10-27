# TODO / future work

Decisions and designs agreed in discussion but not yet built. Keep this current:
remove items when done, add design notes when plans firm up.

## 1. Auth/session hardening

(Compare-first login, the one-shared-session model, and logout-as-detach are
built — see CLAUDE.md. Remaining hardening, all Worker-side:)

- **No throttle protection on the password-login fallback.** A dead refresh
  token + 1-min cron = a password login attempt every minute → throttle
  lockout. Track `lastFullLoginAt` per account and refuse to retry more than
  ~once/hour; cron logs "session dead, backing off" in between.
- **Concurrent refresh race** (cron + pull-to-refresh). If VW rotates refresh
  tokens single-use, the loser kills the session. Mitigate by re-reading stored
  tokens and retrying once before falling back to passwords.
- **Stage markers inside the `vwLogin` HTML scrape.** The scrape is the most
  fragile code we have (by nature); when VW changes the page, today's failure
  is a generic error. Log/throw with the step that died (authorize redirect,
  email-page scrape, password POST, code exchange) so a breakage diagnoses in
  minutes, not an afternoon of re-deriving the flow. Add next time
  `vw/client.ts` login code is open.

Refresh/re-login outcomes are now logged (`[auth]` lines, observability on) —
watch Workers Logs for a week to resolve the remaining unknown: VW
refresh-token lifetime/rotation.

## 2. Per-user schedules (e.g. "climate on at 7am weekdays")

**Do NOT model these as Wrangler crons.** Static crons in `wrangler.jsonc` are
for fixed infrastructure cadences (the 1-min poll). User schedules are *data*:

- A `schedules` entity in InstantDB (vehicle link, time-of-day + days or
  cron-ish spec, action type, enabled flag).
- A frequent fixed cron (~every 5 min) reads due schedules and executes them —
  fits the existing `poll.ts` pattern. The app reads schedules via live query;
  writes go through a new RPC (clients are read-only by permission design).
- Durable Object alarms only if to-the-minute precision ever matters; not
  worth the moving parts at 5-min granularity.

## 3. Vehicle commands

Built: lock/unlock, force-refresh, and **climate** (extended-duration sessions).
The S-PIN/carnet-bearer recipe is in CLAUDE.md.

**Climate (DONE).** Unlike charge, EV climate IS carnet-bearer gated (verified:
the EV summary read 403s with the access token). `pretripclimate/start|stop`
(POST) + `pretripclimate/settings?tempUnit=fahrenheit` (PUT) + the EV summary
for state; all async (confirm via the history poll) and EV-rate-limited
(`EV_THRESHOLD_EXCEEDED` → `VwBusyError`, transient). `vehicle.climateStart`
sets temp first if it differs (climate must be OFF), then starts, and records a
`climateSessions` row the cron keeps alive — **reactive** restart after the
car's ~30-min auto-off (re-issuing start while ON does NOT extend it; verified)
until `expiresAt`, then stops. App: `ClimateControl` card + config Sheet (temp
stepper °F, duration chips, >6 h battery caution). Trade-off accepted: a brief
gap + a VW "climate off" push each ~30-min cycle.

**Charge start/stop + charge limit (DONE).** `vehicle.chargeStart/chargeStop/
setChargeLimit` RPCs + the dashboard charge card (native menu picker for the
limit).

## 4. Events / notifications

**Research conclusion (2026-06-10):** VW exposes no push/webhook/SSE/subscribe
API to third parties on our backend — it's request/response only. Confirmed by
(a) the full endpoint inventory of `b-h-s.spr.us00.p.con-veh.net` (auth, garage,
`rvs` status, `vhs` health, `mps` commands, `ss` S-PIN — no notifications/
messages/events path), and (b) the mature NA connector
(`zackcornelius/CarConnectivity-connector-volkswagen-na`, our reference lineage)
being a **pure polling loop** (configurable interval, min 180s, default 300s; no
FCM/websocket/SSE). The myVW Android app gets real-time alerts via **FCM push** —
a closed VW→Firebase→device channel keyed to VW's own sender ID; intercepting it
means impersonating the app's FCM device registration (fragile, undocumented,
ToS-violating, large effort) and gains little, since the car only reports on wake
anyway (push vs poll differs by latency, not by event availability).
id-buzz-monitor is built on the same OSS and sends its **own** emails — i.e. it
polls + change-detects server-side, exactly the model below. So notifications are
*derived*, not received.

**Design — derive events in the cron, deliver via our own channels:**

- **Detect transitions in `poll.ts`.** `saveSnapshot` already loads the latest
  stored snapshot for dedupe; compare it to the incoming status and emit events:
  charging started/stopped, target SoC reached, plugged/unplugged, became
  unlocked, door/window left open, low SoC, charge interrupted/fault. Emit only
  on transition (old→new edge), and only when fields are non-null on both sides
  (a null→value flip after a gap isn't a real-world event).
- **Per-event dedupe / debounce** so a flapping value can't spam: track the last
  notified state per (vehicle, event-type), e.g. a small `notifications` log or
  `lastNotified` fields; suppress repeats and ignore brief oscillations.
- **Delivery channels:**
  - *Expo push* for the app. Needs a `pushTokens` entity (user/device →
    Expo token), a `notifications.register` RPC, and a server call to Expo's
    push API from the cron. NOTE: iOS remote push needs a **development build** —
    Expo Go can't receive remote push on iOS (works for local notifications
    only). So this lands with the dev-build work (see §6 biometric).
  - *Email* as the zero-client-state option (matches id-buzz-monitor). The
    `cloudflare-email-service` skill fits our Worker; needs a verified sender +
    the user's email (we have `$users.email`, though guests lack one — collect
    at notification opt-in).
- **User prefs:** a `notificationPrefs` entity (per event-type on/off, quiet
  hours, channel) read by the app via live query, written via RPC (clients are
  read-only by permission design).
- **Latency floor = cron cadence** (now 60s), so events surface within ~1 min
  of VW receiving them. Good enough; no push needed to feel live.

## 5. Production deploy (DONE)

Deployed as `vwapp-api` with secrets pushed; the app resolves the API URL at
runtime (Metro host in dev, prod Worker in published builds). Details in
CLAUDE.md. Remaining routine: backend changes need a `wrangler deploy`, app
changes an EAS Update.

## 6. Smaller items

- **Command RPCs don't survive client disconnects.** When the app gives up on
  a slow command (observed: climate stop hanging >60s while the car was
  driven), the runtime cancels the Worker invocation mid-flight — the VW op
  may have landed but the tail work (e.g. `endClimateSession`) never runs, so
  our state diverges from the car's. The `[vw]` lifecycle logs now make this
  visible (a "started" line with no end line); the fix is to persist intent
  before the VW call and/or run the VW-op-plus-tail in `ctx.waitUntil` so it
  finishes after the client hangs up. Needs the execution context threaded
  into the oRPC handlers.
- Biometric gate on app open (needs a dev build, not Expo Go).
- Multi-vehicle support: dashboard currently shows `vehicles[0]` only.
- Login password autofill: add `autoComplete`/`textContentType` so iOS
  Keychain offers the saved password.
- Persist the theme override (it currently resets to system on each launch).
- Track "last fetched from VW" separately from snapshot rows. The dashboard's
  "Updated" label uses `capturedAt` (the car's own report time — correct), but
  its fallback is the snapshot's `createdAt`, which because of the
  capturedAt-dedupe is the *first* poll that saw that capture — possibly much
  older than the latest poll. Easy win: stamp a `lastFetchedAt` (e.g. on the
  vehicle row, updated on every successful poll/refresh even when the snapshot
  dedupes away) and fall back to that — it also enables a "checked VW Xs ago"
  line distinct from "car reported Xm ago".

## 7. Available VW data & capabilities (reference — APK + live probes 2026-06-10)

Full sweep of what VW exposes for this account, from decompiling the US myVW
APK (`/tmp/apk/out`, jadx) and hitting endpoints live with the stored session.
Use this to scope features; most of the wishlist is reachable.

**Two auth tiers (the key enabler):** which Bearer token you send decides
access.
- **Tier 1 — access token** (what the cron already uses): basic status, charge
  summary, health report.
- **Tier 2 — S-PIN `carnetVehicleToken`** (the lock/unlock + force-refresh
  token): location, EV detail, trips, message center, alerts. These return
  `403 USER_NOT_AUTHORIZED` with the access token, `200` with the carnet token.
  We already have the S-PIN session machinery (`vwSpinSession`); a Tier-2 read
  is just "mint the session token, use it as the Bearer." Costs an S-PIN
  challenge per session (guard `remainingTries<3`), so cache/reuse the token
  across reads in one pass rather than minting per-endpoint.

**Near-free wins — already in the `/rvs/v1/vehicle/{uuid}` payload we poll every
minute and currently discard** (Tier 1, no new calls):
- **Per-door open/closed**: frontLeft/Right, rearLeft/Right, **trunk, hood**
  (`exteriorStatus.doorStatus`).
- **Per-door lock state**: all four doors (`exteriorStatus.doorLockStatus`).
- **Per-window** open/closed + sunroof (`exteriorStatus.windowStatus`).
- **Light status**: parking lights on/off, etc. (`exteriorStatus.lightStatus`).
- **Parked location lat/lon + timestamp** (`lastParkedLocation`) — "find my
  car" needs **no S-PIN**; it's right there in the status. Verified present.
- `nextMaintenanceMilestone`, overall `lockStatus`, `clampState`, platform.
  (To surface these: widen `toStatusDTO` + the `snapshots` schema + the
  dashboard. Biggest bang-for-buck next step.)

**Tier-2 reads (verified live, carnet-token Bearer):**
- `GET /rvs/v1/location/vehicle/{uuid}` — live location + **heading**, `parked`
  flag, confidence (fresher than `lastParkedLocation`; for a live map).
- `GET /ev/v1/user/{userId}/vehicle/{uuid}/summary` — richest EV read: SoC,
  range, plug, charge state/type, **chargePower, chargeRate, minutes-to-full**,
  target SoC, max current, auto-unlock-when-charged. Superset of the
  `charge/summary` we currently use.
- `GET /ev/v1/vehicle/{uuid}/pretripclimate/settings` — climate **target temp**
  (valid, e.g. 71°F) + `climatizationElementSettings`: `climatizationAtUnlock`,
  `mirrorHeatingEnabled`, and four `zone{Front,Rear}{Left,Right}Enabled`. These
  six are backend model fields from VW's shared climatisation schema; the US
  myVW app does NOT surface them as toggles (its climate screen is only
  Temperature + Window defogger + Departure timers). Best read of the schema:
  `climatizationAtUnlock` is an independent *trigger* (auto-climatise on unlock,
  currently `true`), and the `zone*` flags select *which seating positions are
  conditioned whenever climatisation runs* (currently all `false`) — i.e. they
  are independent of each other, NOT "unlock turns on the seats". Not
  UI-confirmed for this US variant (EU WeConnect app would label them); confirm
  before building a climate-settings UI.
- `GET /poi/v1/vehicle/{uuid}/trip` — trips (`tripsSupported:true`, empty now);
  `/poi/.../sessions` public-charging history (status, invoice PDFs, active).

**Tier-1 reads (verified live, access-token Bearer):**
- `GET /vhs/v2/vehicle/{uuid}` — health report: overall + per-category status
  (Comfort, Driver Assist, Powertrain, **Tires & Brakes**) with diagnostic
  messages, and **next service due** (km + days). NOTE: category health only —
  **no live tire-pressure psi**.

**NOT available (don't chase):**
- **Cabin / outdoor temperature.** Fields exist
  (`ev .../summary` → `climateStatus.temperature.{inCabin,outdoor}Temperature`)
  but VW returns `measurementState:"invalid"`, `status:"FAILURE"`, literally
  *"Deprecated from Device Platform, so sending incorrect values"* (80°F
  placeholder). For exterior temp, derive from `lastParkedLocation` + a weather
  API (this is almost certainly how id-buzz-monitor does it). Only the climate
  **setpoint** is valid, not ambient/cabin readings.
- Live tire pressure (psi) — see health report above.

**Notification sources (feeds for §4, beyond diffing snapshots):**
- `GET /history/activity/v1/vehicle/{uuid}` (Tier 2) — VW's own activity feed,
  **89 events**, paginated, queryable by `activityType` (Commands / **Trip** /
  **Alert**), `timeFrame`, `pageNum`, `pageSize`. Each: timestamp, title,
  description, icon URL.
- `GET /messagecenter/v2/user/{userId}/vehicle/{uuid}` (Tier 2) — VW's in-app
  inbox; `/unRead/count` → `{totalUnread, offersUnread, messagesUnread}`; the
  list needs a `?type=` param (`offers`, messages). A curated VW message stream
  we could mirror.

**Write-capabilities seen (S-PIN/`roToken` gated; not yet built):** honk/flash
(`/honkflash`), remote start (`/rst`, PIN→`roToken` flow), charge start/stop
(`/ev/.../charging/{startStop}`), climate start/stop + window heating
(`/ev/.../pretripclimate/{start,stop,windowheating}`), **departure timers**
(`/ev/.../pretripclimate/timers` — the surface for scheduled climate, §2),
digital key / pairing (`/mdk`, `/pair`).

**Deprioritized — VW-side alerts** (`/alert/v1/vehicle/{uuid}/{boundary,speed,
curfew,valet}`, Tier 2, all `eligible:true`, creatable): geofence / speed /
curfew / valet alerts that VW evaluates server-side. **Not planned any time
soon** — we'd still own delivery (VW's push channel stays closed, §4), and our
own snapshot-diff + activity-feed covers the interesting cases. Documented only
for completeness.

## Voice assistant — built, remaining follow-ups

The press-and-hold voice assistant is built (`assistant.ask`,
`backend/src/assistant.ts`, `app/src/components/voice-control.tsx`) — all
inference on Workers AI (Whisper → GLM-5.2 tools → MeloTTS). Open items:

- **Live-verify the Workers AI shapes against the account.** GLM-5.2 post-dates
  the installed typings; the binding tool-call response shape and MeloTTS audio
  encoding are coded to the unified `ChatCompletions*` / TTS schemas but unrun.
  Confirm with a real call (a `scripts/assistant-smoke.ts` was planned) before
  trusting it end-to-end.
- **Latency.** STT + a *reasoning* LLM + TTS in series may be slow; we run
  `reasoning_effort: "low"` + small `max_completion_tokens`. If too slow,
  consider a faster model (e.g. a GLM-Flash) or partial/streamed UI.
- **Voice unlock has no confirmation** (deliberate for now). Revisit if a spoken
  "are you sure" or a re-auth gate is wanted.
- **Audio format.** `expo-audio` records m4a/aac; confirm Whisper accepts it
  (else record/transcode to wav).
