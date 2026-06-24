/**
 * InstantDB schema, shared by the Worker (admin SDK) and the Expo app
 * (react-native SDK). Identity is Instant's built-in $users — the app signs in
 * as a guest and the Worker verifies that guest's token, so there is no custom
 * users entity or device-token scheme.
 */
import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
    }),
    // Server-only (deny-all perms): THE one VW session per VW account —
    // sealed credentials + tokens. Many Instant users (app installs, scripts)
    // attach to the same row; the Worker talks to VW only through it.
    vwAccounts: i.entity({
      /** sha256 of the normalized VW username — the convergence key. */
      userKey: i.string().unique().indexed().optional(),
      credCiphertext: i.string(),
      credIv: i.string(),
      accessToken: i.string(),
      refreshToken: i.string().optional(),
      idToken: i.string().optional(),
      tokenExpiresAt: i.number(),
    }),
    vehicles: i.entity({
      vin: i.string().indexed(),
      // Unique within an account (one row per car per VW account).
      uuid: i.string().indexed(),
      nickname: i.string().optional(),
      model: i.string().optional(),
    }),
    // A user-requested "keep climate on for N hours" session. The car's own
    // pre-trip climate auto-stops at ~30 min, so the cron restarts it (reactive
    // — re-issuing start while on does NOT extend) until expiresAt, then stops
    // it. One active session per vehicle. The app live-queries this.
    climateSessions: i.entity({
      tempF: i.number(),
      /** epoch ms when our managed session ends and the cron stops climate. */
      expiresAt: i.number().indexed(),
      startedAt: i.number(),
      /** "active" while we keep it warm; terminal: "expired" | "stopped" | "failed". */
      state: i.string().indexed(),
      /** last time the cron (re)issued start. */
      lastStartAt: i.number().optional(),
      /** last observed car remainingClimatizationTimeMin (for display). */
      remainingMin: i.number().optional(),
      /** last error surfaced by the keepalive, if any. */
      error: i.string().optional(),
      /**
       * Set when VW rejected a start with "ignition on" (car in use). The
       * keepalive skips starts until the car reports a parking event newer
       * than this, instead of spamming doomed starts every tick.
       */
      pausedAt: i.number().optional(),
    }),
    // Mirror of VW's message-center inbox. The Worker syncs VW's messages into
    // here (the app never talks to VW); the app live-queries these. `read` is
    // VW's own flag (their source of truth, re-mirrored on every sync);
    // `readOverride` is OUR per-message override that survives syncs —
    // absent/null = follow VW, true = read, false = unread. Effective read =
    // readOverride ?? read. `deletedAt` is OUR soft-delete (set when the user
    // deletes a message locally) — it survives syncs too and hides the row from
    // the app, WITHOUT telling VW. Both overrides are preserved by syncMessages
    // (it only writes VW's own fields on upsert). Rows VW itself stops returning
    // are hard-pruned (genuine upstream deletions).
    messages: i.entity({
      /** VW notificationId — unique within an account. */
      messageId: i.string().indexed(),
      title: i.string(),
      body: i.string().optional(),
      /** VW message timestamp, epoch ms. */
      at: i.number().optional(),
      /** VW's read flag, re-mirrored on each sync. */
      read: i.boolean(),
      /** Our override; absent/null = follow VW, else wins over `read`. */
      readOverride: i.boolean().optional(),
      /** Our soft-delete marker, epoch ms; absent/null = not deleted. Survives
          VW syncs; hidden from the app. Never sent to VW. */
      deletedAt: i.number().optional(),
      /** Ordering key (= VW `at`, or first-seen time). Indexed for order. */
      createdAt: i.number().indexed(),
    }),
    // One row per VW status fetch; the app live-queries the latest of these.
    snapshots: i.entity({
      /** When the Worker stored this row. Indexed for order/prune queries. */
      createdAt: i.number().indexed(),
      /** When VW captured the data, epoch ms. */
      capturedAt: i.number().optional(),
      soc: i.number().optional(),
      chargeState: i.string().optional(),
      chargePowerKw: i.number().optional(),
      minutesToFull: i.number().optional(),
      pluggedIn: i.boolean().optional(),
      plugLocked: i.boolean().optional(),
      targetSoc: i.number().optional(),
      locked: i.boolean().optional(),
      rangeKm: i.number().optional(),
      odometerKm: i.number().optional(),
      /** Open closures (doors/trunk/hood) and windows, by friendly name. */
      openDoors: i.json().optional(),
      openWindows: i.json().optional(),
      /** Doors unlocked while the car isn't fully secure (rare). */
      unlockedDoors: i.json().optional(),
      /** Where the car last parked (from RVS `lastParkedLocation`). */
      parkedLat: i.number().optional(),
      parkedLng: i.number().optional(),
      parkedAt: i.number().optional(),
      /** Per-category update times reported by VW (epoch ms), shown on the
          status-updates screen. */
      rvsUpdatedAt: i.number().optional(),
      doorsUpdatedAt: i.number().optional(),
      locksUpdatedAt: i.number().optional(),
      windowsUpdatedAt: i.number().optional(),
      chargeUpdatedAt: i.number().optional(),
    }),
  },
  links: {
    // Many clients share one VW session; each client belongs to at most one.
    // No cascade, and no GC on detach: the session persists even with zero
    // clients so server-side automation (cron, future schedules) can keep
    // authenticating with VW. Deletion is explicit (wipe script / future UI).
    accountUsers: {
      forward: { on: "vwAccounts", has: "many", label: "users" },
      reverse: { on: "$users", has: "one", label: "account" },
    },
    vehicleAccount: {
      forward: {
        on: "vehicles",
        has: "one",
        label: "account",
        onDelete: "cascade",
      },
      reverse: { on: "vwAccounts", has: "many", label: "vehicles" },
    },
    snapshotVehicle: {
      forward: {
        on: "snapshots",
        has: "one",
        label: "vehicle",
        onDelete: "cascade",
      },
      reverse: { on: "vehicles", has: "many", label: "snapshots" },
    },
    messageAccount: {
      forward: {
        on: "messages",
        has: "one",
        label: "account",
        onDelete: "cascade",
      },
      reverse: { on: "vwAccounts", has: "many", label: "messages" },
    },
    climateSessionVehicle: {
      forward: {
        on: "climateSessions",
        has: "one",
        label: "vehicle",
        onDelete: "cascade",
      },
      reverse: { on: "vehicles", has: "many", label: "climateSessions" },
    },
  },
});

type _AppSchema = typeof _schema;
// The interface-extends indirection keeps hovers/errors short ("AppSchema"
// instead of the expanded structural type) — Instant's canonical template.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
