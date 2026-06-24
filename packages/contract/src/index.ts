import { oc } from "@orpc/contract";
import { z } from "zod";

/** A vehicle in the user's garage. */
export const vehicleSchema = z.object({
  vin: z.string(),
  uuid: z.string(),
  nickname: z.string().nullable(),
  model: z.string().nullable(),
});
export type VehicleDTO = z.infer<typeof vehicleSchema>;

/** Live status for one vehicle (mirrors the verified PoC summary). */
export const statusSchema = z.object({
  vin: z.string(),
  soc: z.number().nullable(),
  chargeState: z.string().nullable(),
  chargePowerKw: z.number().nullable(),
  minutesToFull: z.number().nullable(),
  pluggedIn: z.boolean().nullable(),
  plugLocked: z.boolean().nullable(),
  targetSoc: z.number().nullable(),
  locked: z.boolean().nullable(),
  /** Open closures/windows and unlocked doors, by friendly name (e.g. "trunk"). */
  openDoors: z.array(z.string()),
  openWindows: z.array(z.string()),
  unlockedDoors: z.array(z.string()),
  /** Canonical km (the app converts to the user's preferred units). */
  rangeKm: z.number().nullable(),
  odometerKm: z.number().nullable(),
  /** Where the car last parked (`parkedAt` is epoch ms). */
  parkedLat: z.number().nullable(),
  parkedLng: z.number().nullable(),
  parkedAt: z.number().nullable(),
  /** When VW captured this data, epoch ms. */
  capturedAt: z.number().nullable(),
  /** Per-category update times VW reports alongside the data (epoch ms). */
  rvsUpdatedAt: z.number().nullable(),
  doorsUpdatedAt: z.number().nullable(),
  locksUpdatedAt: z.number().nullable(),
  windowsUpdatedAt: z.number().nullable(),
  chargeUpdatedAt: z.number().nullable(),
});
export type StatusDTO = z.infer<typeof statusSchema>;

/** Just the VW account credentials — what's validated before we ask for the S-PIN. */
const loginCredentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const credentialsSchema = loginCredentialsSchema.extend({
  /** myVW security PIN (4 digits), required for remote commands like lock/unlock. */
  spin: z.string().regex(/^\d{4,6}$/, "S-PIN must be 4–6 digits"),
});

/** One entry in the vehicle's activity log. */
export const activityEventSchema = z.object({
  at: z.number().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string().nullable(),
});
export type ActivityEventDTO = z.infer<typeof activityEventSchema>;

/** One message-center inbox item. */
export const inboxMessageSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  read: z.boolean(),
  at: z.number().nullable(),
});
export type InboxMessageDTO = z.infer<typeof inboxMessageSchema>;

/** A remote command that changes vehicle state (needs the stored S-PIN). */
export const commandSchema = z.object({
  uuid: z.string().optional(),
  action: z.enum(["lock", "unlock"]),
});
export type CommandInput = z.infer<typeof commandSchema>;

/** A pinned-location request for a signed Apple Maps snapshot image URL. */
export const parkedMapSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  /** Display size in points; the server renders at 2x for retina. */
  widthPt: z.number().int().min(100).max(640),
  heightPt: z.number().int().min(100).max(640),
  dark: z.boolean(),
});
export type ParkedMapInput = z.infer<typeof parkedMapSchema>;

/** Start a managed climate session: keep climate on for `durationMin`, at `tempF`. */
export const climateStartSchema = z.object({
  uuid: z.string().optional(),
  /** Cabin target temperature, °F (VW range). */
  tempF: z.number().int().min(60).max(85),
  /** How long to keep climate on, minutes (5 min – 24 h). >6 h warns in the UI. */
  durationMin: z.number().int().min(5).max(1440),
});
export type ClimateStartInput = z.infer<typeof climateStartSchema>;

/**
 * End-to-end typed API contract, shared by the Worker and the Expo app.
 *
 * Vehicle and snapshot *data* is not served here — the app live-queries it
 * from InstantDB directly. These procedures only cover what requires the
 * Worker: VW credentials and on-demand VW fetches.
 */
export const contract = {
  auth: {
    /**
     * Validate VW credentials (username + password) — the first step of the
     * two-step sign-in, so a wrong password is caught before the user is asked
     * for their S-PIN. Caches the validated VW session server-side but does NOT
     * log the client in (no S-PIN yet), so the follow-up `login` needs no second
     * VW password login. Throws UNAUTHORIZED on bad credentials.
     */
    checkCredentials: oc
      .input(loginCredentialsSchema)
      .output(z.object({ ok: z.literal(true) })),
    /**
     * Attach this client to the shared VW session. Reuses the saved session
     * when the submitted credentials match the stored copy and its tokens
     * still work against VW; otherwise performs a real VW login (throttled
     * by VW) and rotates the stored credentials/tokens. This is the only step
     * that persists the account — always with the S-PIN.
     */
    login: oc
      .input(credentialsSchema)
      .output(z.object({ ok: z.literal(true) })),
    /** Whether this Instant user has stored VW credentials. */
    me: oc.output(z.object({ loggedIn: z.boolean() })),
    /**
     * Detach this client from the shared VW session. The session itself (and
     * its vehicles/snapshots) persists server-side so the cron and future
     * schedules keep working; deleting it is a separate, explicit act.
     */
    logout: oc.output(z.object({ ok: z.literal(true) })),
  },
  vehicle: {
    /**
     * Fetch live status from VW now and store a snapshot (which the app
     * receives via its InstantDB subscription). Defaults to the single
     * vehicle when uuid is omitted.
     */
    refresh: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(statusSchema),
    /**
     * Lock or unlock the doors via VW (S-PIN-gated server-side). Waits for VW
     * to confirm the new state, stores a snapshot, and returns the confirmed
     * lock state (which also arrives via the app's snapshot subscription).
     */
    command: oc
      .input(commandSchema)
      .output(
        z.object({ ok: z.literal(true), locked: z.boolean().nullable() }),
      ),
    /**
     * Start a managed climate session (S-PIN-gated). Sets the target temp
     * first if it differs (climate must be off to set temp), turns climate on,
     * and records a session the cron keeps alive until it expires. The app
     * live-queries `climateSessions` for live state.
     */
    climateStart: oc
      .input(climateStartSchema)
      .output(z.object({ ok: z.literal(true) })),
    /** Stop climate now and end the managed session. */
    climateStop: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(z.object({ ok: z.literal(true) })),
    /** The car's current cabin target temperature (°F) — used to seed the start dialog. */
    climateInfo: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(z.object({ targetTempF: z.number().nullable() })),
    /** Start charging now (S-PIN-gated). Requires the car to be plugged in. */
    chargeStart: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Stop charging now (S-PIN-gated). Async at VW; the snapshot reflects it shortly. */
    chargeStop: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Set the charge limit (target SoC %, 10% steps). S-PIN-gated. */
    setChargeLimit: oc
      .input(
        z.object({
          uuid: z.string().optional(),
          targetSoc: z.number().int().min(50).max(100).multipleOf(10),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** The car's recent activity log (commands/trips/alerts). S-PIN-gated read. */
    activity: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(z.object({ events: z.array(activityEventSchema) })),
    /** myVW message-center inbox. S-PIN-gated read. (Used in-process by the
        voice assistant; the app reads messages from InstantDB instead.) */
    messages: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(z.object({ messages: z.array(inboxMessageSchema) })),
    /**
     * Sync the message-center inbox from VW into InstantDB (mirror): upsert
     * messages, preserve our read overrides, and prune deletions. The app calls
     * this to refresh, then reads the messages from InstantDB — it never sees
     * VW directly. S-PIN-gated.
     */
    refreshMessages: oc
      .input(z.object({ uuid: z.string().optional() }))
      .output(z.object({ ok: z.literal(true) })),
    /**
     * Set our per-message read override in InstantDB: true = read, false =
     * unread, null = follow VW's own flag. No VW traffic.
     */
    setMessageRead: oc
      .input(
        z.object({
          messageId: z.string().min(1),
          read: z.boolean().nullable(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /**
     * Soft-delete (or restore) a message in our DB only — never sent to VW.
     * `deleted` true hides it from the app and survives VW re-syncs; false
     * restores it. No VW traffic.
     */
    setMessageDeleted: oc
      .input(
        z.object({
          messageId: z.string().min(1),
          deleted: z.boolean(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /**
     * A signed Apple Maps Web Snapshot URL for the parked location. The Worker
     * signs it with the server-held MapKit key (the .p8 never leaves the
     * backend); the app loads the result as a plain image — no native map
     * module needed, so it renders the same in Expo Go and production.
     */
    parkedMapUrl: oc
      .input(parkedMapSchema)
      // url is null when the backend has no Apple Maps signing keys configured
      // (the parked-map feature is optional — the app falls back to coords).
      .output(z.object({ url: z.string().nullable() })),
  },
  assistant: {
    /**
     * Voice assistant: send a short recorded voice note (base64 audio) and get
     * back a transcript, a short reply, and synthesized speech (base64 audio,
     * null if TTS failed). The Worker runs the whole chain on Cloudflare
     * Workers AI — speech-to-text, an LLM that calls vehicle tools (the same
     * status reads and S-PIN-gated commands the other procedures expose), and
     * text-to-speech. Defaults to the single vehicle when uuid is omitted.
     */
    ask: oc
      .input(
        z.object({
          uuid: z.string().optional(),
          /** Base64-encoded recorded audio (m4a/aac from the app recorder). */
          audioBase64: z.string().min(1),
        }),
      )
      .output(
        z.object({
          transcript: z.string(),
          reply: z.string(),
          /** Base64 WAV (PCM) of the spoken reply, or null if TTS was unavailable. */
          audioBase64: z.string().nullable(),
        }),
      ),
  },
};

export type Contract = typeof contract;
