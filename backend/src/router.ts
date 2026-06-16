import { implement, ORPCError } from "@orpc/server";
import { contract, type VehicleDTO } from "@vwapp/contract";
import { seal, sha256Hex, timingSafeEqual, unseal } from "./crypto";
import type { AppEnv } from "./env";
import { signSnapshotUrl } from "./maps";
import {
  clearUserData,
  endClimateSession,
  getAccountByUserKey,
  getActiveClimateSession,
  getUser,
  saveLogin,
  saveSnapshot,
  startClimateSession,
  updateClimateSession,
  type Db,
  type StoredAccount,
  type StoredUser,
  type StoredVehicle,
} from "./store";
import { ensureTokens, reauth } from "./tokens";
import {
  VwAuthError,
  vwAwaitCommandResult,
  VwBusyError,
  vwChargeStart,
  vwChargeStop,
  vwClimateStart,
  vwClimateStop,
  VwCommandError,
  vwForceRefresh,
  vwGetActivity,
  vwGetClimate,
  vwGetClimateTargetTempF,
  vwGetMessages,
  vwGetStatus,
  vwGetVehicles,
  vwLockUnlock,
  vwLogin,
  vwMintSpinSession,
  vwRefresh,
  vwSetChargeLimit,
  vwSetClimateTemp,
  type VwTokens,
} from "./vw/client";

/** The requested vehicle (defaults to the only one when uuid is omitted). */
function pickVehicle(
  user: StoredUser,
  uuid: string | undefined,
): StoredVehicle {
  const vehicle =
    uuid === undefined
      ? user.vehicles[0]
      : user.vehicles.find((v) => v.uuid === uuid);
  if (vehicle === undefined)
    throw new ORPCError("NOT_FOUND", { message: "vehicle not found" });
  return vehicle;
}

export interface RouterContext {
  env: AppEnv;
  db: Db;
  /** Instant user id from the verified guest token, or null if unauthenticated. */
  userId: string | null;
}

const os = implement(contract).$context<RouterContext>();

function requireUser(context: RouterContext): string {
  if (context.userId === null)
    throw new ORPCError("UNAUTHORIZED", {
      message: "missing or invalid Instant auth token",
    });
  return context.userId;
}

/**
 * One VW account = one vwAccounts row, shared by every client (app installs,
 * scripts) that logs in with it. The convergence key is a hash of the
 * normalized username, so a fresh guest identity attaches to the existing
 * session instead of creating a parallel one.
 */
function vwUserKey(username: string): Promise<string> {
  return sha256Hex(username.trim().toLowerCase());
}

/** Compare digests, never the raw secrets (and never log either). */
async function storedPasswordMatches(
  env: AppEnv,
  account: StoredAccount,
  password: string,
): Promise<boolean> {
  let stored;
  try {
    stored = JSON.parse(await unseal(env.CREDS_ENC_KEY, account.sealed)) as {
      password?: string;
    };
  } catch {
    return false; // unreadable (e.g. sealed under an old key) — re-login and re-seal
  }
  if (stored.password === undefined) return false;
  // Compare fixed-length digests in constant time: never `===` on the raw
  // secret (length leak) nor on the digests (the positional-timing leak this
  // avoids), even though both are already in memory here.
  return timingSafeEqual(
    await sha256Hex(stored.password),
    await sha256Hex(password),
  );
}

/**
 * Prove the saved VW session still works: a real garage call with the stored
 * access token, refreshing first when it's expired or rejected. Returns null
 * when VW accepts neither token — the caller then does a full password login.
 * (Any verification failure falls back the same way; vwLogin is the
 * authoritative judge of the submitted credentials.)
 */
async function verifySavedSession(
  account: StoredAccount,
): Promise<{ tokens: VwTokens; vehicles: VehicleDTO[] } | null> {
  const { tokens } = account;
  if (tokens.expiresAt > Date.now() + 60_000) {
    try {
      return { tokens, vehicles: await vwGetVehicles(tokens.accessToken) };
    } catch {
      // fall through to a refresh attempt
    }
  }
  if (tokens.refreshToken === null) return null;
  try {
    const fresh = await vwRefresh(tokens.refreshToken);
    return { tokens: fresh, vehicles: await vwGetVehicles(fresh.accessToken) };
  } catch {
    return null;
  }
}

const login = os.auth.login.handler(async ({ input, context }) => {
  const userId = requireUser(context);
  const userKey = await vwUserKey(input.username);

  // Compare-first: when this VW account already has a server-side session
  // whose stored password matches the submitted one AND whose tokens still
  // work against VW, attach the client to it without burning a (throttled)
  // VW password login. Each branch logs its decision — the difference between
  // "attach, no VW traffic" and "full password login" is invisible to the
  // client but is exactly what a login-failure postmortem needs.
  const existing = await getAccountByUserKey(context.db, userKey);
  let session: { tokens: VwTokens; vehicles: VehicleDTO[] } | null = null;
  if (
    existing !== null &&
    (await storedPasswordMatches(context.env, existing, input.password))
  ) {
    session = await verifySavedSession(existing);
    console.log(
      `[auth] login account=${existing.id}: digest match, saved session ${
        session !== null
          ? "verified — attaching with no VW login"
          : "dead — full login required"
      }`,
    );
  } else {
    console.log(
      `[auth] login: ${existing === null ? "no stored account for this user key" : `account=${existing.id} digest mismatch`} — full VW login`,
    );
  }

  // No session, changed/wrong password, or dead tokens: authenticate with VW
  // for real, rotating the stored credentials and tokens.
  if (session === null) {
    let tokens;
    try {
      tokens = await vwLogin(input.username, input.password);
      console.log(`[auth] login: VW password login ok`);
    } catch (err) {
      console.error(
        `[auth] login: VW password login FAILED: ${err instanceof Error ? err.message : "unknown"}`,
      );
      if (err instanceof VwAuthError)
        throw new ORPCError("UNAUTHORIZED", { message: err.message });
      throw err;
    }
    session = { tokens, vehicles: await vwGetVehicles(tokens.accessToken) };
  }

  const sealed = await seal(
    context.env.CREDS_ENC_KEY,
    JSON.stringify({
      username: input.username,
      password: input.password,
      spin: input.spin,
    }),
  );
  const stored = await saveLogin(
    context.db,
    userId,
    userKey,
    sealed,
    session.tokens,
    session.vehicles,
  );

  // Best effort: store an initial snapshot per vehicle so the dashboard has
  // data the moment it appears, instead of waiting for the cron or a manual
  // refresh.
  try {
    for (const v of stored) {
      await saveSnapshot(
        context.db,
        v.id,
        await vwGetStatus(session.tokens.accessToken, v.vin, v.uuid),
      );
    }
  } catch (err) {
    console.error("initial status fetch after login failed", err);
  }
  return { ok: true as const };
});

const me = os.auth.me.handler(async ({ context }) => {
  const userId = requireUser(context);
  const user = await getUser(context.db, userId);
  return { loggedIn: user.account !== null };
});

const logout = os.auth.logout.handler(async ({ context }) => {
  const userId = requireUser(context);
  const user = await getUser(context.db, userId);
  await clearUserData(context.db, user);
  return { ok: true as const };
});

/**
 * Best-effort: poke the actual car (S-PIN gated wake) so VW gets fresh
 * telemetry. Asynchronous — the car reports in ~10–60s and the cron's next
 * poll stores the fresh snapshot, which streams to the app via its live query.
 * Never throws: no stored S-PIN, throttling, or any VW rejection just means we
 * fall back to returning VW's current cloud-cached status below.
 */
async function tryWakeVehicle(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  tokens: VwTokens,
  uuid: string,
): Promise<void> {
  try {
    const creds = JSON.parse(
      await unseal(env.CREDS_ENC_KEY, account.sealed),
    ) as { spin?: string };
    if (creds.spin === undefined || creds.spin === "") return; // no S-PIN → can't wake
    try {
      await vwForceRefresh(tokens, uuid, creds.spin);
    } catch (err) {
      if (!(err instanceof VwAuthError)) throw err;
      const fresh = await reauth(db, env, account, true);
      await vwForceRefresh(fresh, uuid, creds.spin);
    }
  } catch (err) {
    console.error(
      "wake (force-refresh) failed; using cloud-cached status",
      err,
    );
  }
}

const refresh = os.vehicle.refresh.handler(async ({ input, context }) => {
  const userId = requireUser(context);
  const user = await getUser(context.db, userId);
  if (user.account === null)
    throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
  const account = user.account;
  const vehicle = pickVehicle(user, input.uuid);

  return loggedOp(`refresh vehicle=${vehicle.id}`, async () => {
    const tokens = await ensureTokens(context.db, context.env, account);

    // Actually poke the car first; its fresh telemetry arrives async via the
    // cron + live query. Then read VW's current cloud status for an immediate
    // snapshot + return value (likely still pre-wake — that's fine).
    await tryWakeVehicle(
      context.db,
      context.env,
      account,
      tokens,
      vehicle.uuid,
    );

    let result;
    try {
      result = await vwGetStatus(tokens.accessToken, vehicle.vin, vehicle.uuid);
    } catch (err) {
      if (!(err instanceof VwAuthError)) throw err;
      const fresh = await reauth(context.db, context.env, account, true);
      result = await vwGetStatus(fresh.accessToken, vehicle.vin, vehicle.uuid);
    }
    // The app's snapshot subscription delivers this; the return value is only a
    // convenience for scripts.
    await saveSnapshot(context.db, vehicle.id, result);
    return result;
  });
});

const command = os.vehicle.command.handler(async ({ input, context }) => {
  const { db, env } = context;
  const userId = requireUser(context);
  const user = await getUser(db, userId);
  if (user.account === null)
    throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
  const vehicle = pickVehicle(user, input.uuid);

  const creds = JSON.parse(
    await unseal(env.CREDS_ENC_KEY, user.account.sealed),
  ) as {
    spin?: string;
  };
  if (creds.spin === undefined || creds.spin === "")
    throw new ORPCError("FORBIDDEN", {
      message:
        "No S-PIN stored. Sign out and back in to enable remote commands.",
    });
  const spin = creds.spin;

  const account = user.account;
  return loggedOp(
    `command action=${input.action} vehicle=${vehicle.id}`,
    async () => {
      // One retry path: a stale access token surfaces as VwAuthError, so force a
      // re-login and try once more. VwCommandError (bad PIN, refusal) is terminal.
      let tokens = await ensureTokens(db, env, account);
      let correlationId: string;
      try {
        correlationId = await vwLockUnlock(
          tokens,
          vehicle.uuid,
          spin,
          input.action,
        );
      } catch (err) {
        if (err instanceof VwCommandError)
          throw new ORPCError("BAD_REQUEST", { message: err.message });
        if (!(err instanceof VwAuthError)) throw err;
        tokens = await reauth(db, env, account, true);
        try {
          correlationId = await vwLockUnlock(
            tokens,
            vehicle.uuid,
            spin,
            input.action,
          );
        } catch (retryErr) {
          if (retryErr instanceof VwCommandError)
            throw new ORPCError("BAD_REQUEST", { message: retryErr.message });
          throw retryErr;
        }
      }
      console.log(
        `[vw] command action=${input.action} accepted correlationId=${correlationId}`,
      );

      // VW's `result: 0` only means "accepted" — the car may still reject it (e.g.
      // ignition on, door open). Poll the operation history until it confirms, the
      // way the myVW app does; an explicit failure throws here and surfaces to the
      // app. (Resolves false on timeout — rare; we then fall back to optimistic.)
      try {
        await vwAwaitCommandResult(
          tokens.accessToken,
          vehicle.uuid,
          correlationId,
        );
      } catch (err) {
        if (err instanceof VwCommandError)
          throw new ORPCError("BAD_REQUEST", { message: err.message });
        if (!(err instanceof VwAuthError)) throw err;
        // token died mid-poll; the command was already accepted — fall through.
      }

      // Snapshot the confirmed state. RVS still lags the physical action, so trust
      // the action we just confirmed for `locked`; the cron reconciles the rest.
      const want = input.action === "lock";
      const status = await vwGetStatus(
        tokens.accessToken,
        vehicle.vin,
        vehicle.uuid,
      );
      await saveSnapshot(
        db,
        vehicle.id,
        { ...status, locked: want },
        { force: true },
      );
      return { ok: true as const, locked: want };
    },
  );
});

/** Unseal the stored S-PIN or fail with a clear message. */
async function requireSpin(
  env: AppEnv,
  account: StoredAccount,
): Promise<string> {
  const creds = JSON.parse(await unseal(env.CREDS_ENC_KEY, account.sealed)) as {
    spin?: string;
  };
  if (creds.spin === undefined || creds.spin === "")
    throw new ORPCError("FORBIDDEN", {
      message:
        "No S-PIN stored. Sign out and back in to enable remote commands.",
    });
  return creds.spin;
}

/** Map VW client errors to user-facing oRPC errors (terminal failures). */
function mapVwError(err: unknown): never {
  if (err instanceof VwBusyError)
    throw new ORPCError("BAD_REQUEST", {
      message:
        "The vehicle is busy with a previous request. Try again in a moment.",
    });
  if (err instanceof VwCommandError)
    throw new ORPCError("BAD_REQUEST", { message: err.message });
  throw err;
}

/** Await an EV/command op's terminal result; rethrow explicit failures, ignore
 *  auth/timeout (op was accepted). Spacing ops this way avoids EV_THRESHOLD. */
async function confirmOp(
  accessToken: string,
  uuid: string,
  correlationId: string,
): Promise<void> {
  try {
    await vwAwaitCommandResult(accessToken, uuid, correlationId, {
      attempts: 6,
      intervalMs: 2500,
    });
  } catch (err) {
    if (err instanceof VwCommandError)
      throw new ORPCError("BAD_REQUEST", { message: err.message });
    // VwAuthError or timeout: the op was accepted; let the cron/state reconcile.
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bracket a VW command sequence in the log with its duration. A "started"
 * line with no matching finished/failed line is the signature of a canceled
 * invocation (client disconnected mid-flight and the runtime killed the
 * handler) — a failure mode that is otherwise completely invisible.
 */
async function loggedOp<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  console.log(`[vw] ${label} started`);
  try {
    const out = await fn();
    console.log(`[vw] ${label} finished in ${String(Date.now() - t0)}ms`);
    return out;
  } catch (err) {
    console.error(
      `[vw] ${label} failed in ${String(Date.now() - t0)}ms: ${err instanceof Error ? err.message : "unknown"}`,
    );
    throw err;
  }
}

/** Run an EV write, retrying through VW's transient EV_THRESHOLD ("vehicle
 *  busy") window — back-to-back EV ops are rate-limited even after the prior
 *  one is accepted. Non-busy errors propagate immediately. Retries and
 *  exhaustion are logged: how long VW's busy windows really run is exactly
 *  what we keep having to guess at when tuning these budgets. */
async function retryOnBusy<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const { attempts = 3, delayMs = 5000 } = opts;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VwBusyError && i < attempts - 1) {
        console.log(
          `[vw] ${label}: busy (attempt ${String(i + 1)}/${String(attempts)}) — retrying in ${String(delayMs)}ms`,
        );
        await sleep(delayMs);
        continue;
      }
      if (err instanceof VwBusyError)
        console.log(
          `[vw] ${label}: still busy after ${String(attempts)} attempts — giving up`,
        );
      throw err;
    }
  }
}

/**
 * After a set-temp op (the PUT already returned 200 = accepted), give the car a
 * chance to reflect the new target in the settings read before we start — both
 * to confirm and to space past VW's EV rate-limit. The apply latency is
 * variable (seen ~7s, sometimes longer), so this is **best-effort**: it returns
 * as soon as the temp reflects, and otherwise returns after the window without
 * failing (the change was accepted and applies shortly; the start retries
 * through any residual rate-limit). A genuinely failed PUT already threw upstream.
 */
async function settleTempChange(
  accessToken: string,
  uuid: string,
  tempF: number,
): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if ((await vwGetClimateTargetTempF(accessToken, uuid)) === tempF) return;
    await sleep(2500);
  }
}

/** Poll climate state (carnet read) until it's off, so temp can be set. */
async function waitForClimateOff(
  carnet: string,
  tokens: VwTokens,
  uuid: string,
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if (!(await vwGetClimate(carnet, tokens, uuid)).on) return;
    await sleep(2500);
  }
  throw new VwCommandError(
    "Couldn't turn climate off to change the temperature — please try again.",
  );
}

const climateStart = os.vehicle.climateStart.handler(
  async ({ input, context }) => {
    const { db, env } = context;
    const userId = requireUser(context);
    const user = await getUser(db, userId);
    if (user.account === null)
      throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
    const account = user.account;
    const vehicle = pickVehicle(user, input.uuid);

    // Adjusting only the duration is a pure reschedule: the cron is what keeps
    // climate warm, so just move the active session's end — no VW round-trip
    // (S-PIN mint + a redundant start that wouldn't extend anything anyway).
    const active = await getActiveClimateSession(db, vehicle.id);
    if (active !== null && active.tempF === input.tempF) {
      await updateClimateSession(db, active.id, {
        expiresAt: Date.now() + input.durationMin * 60_000,
      });
      // The cron may have expired the session (stopping the car) between the
      // read and the write, leaving our update on a dead row — re-check and on
      // a lost race fall through to a real start. (A cron tick already past its
      // expiry check can still stop the car moments after this; the next tick
      // then sees the active session and restarts. Unavoidable without locks.)
      const after = await getActiveClimateSession(db, vehicle.id);
      if (after !== null && after.id === active.id) {
        console.log(
          `[vw] climate start vehicle=${vehicle.id}: rescheduled session=${active.id} only — no VW traffic`,
        );
        return { ok: true as const };
      }
    }

    const spin = await requireSpin(env, account);

    return loggedOp(
      `climate start vehicle=${vehicle.id} tempF=${String(input.tempF)} durationMin=${String(input.durationMin)}`,
      async () => {
        let tokens = await ensureTokens(db, env, account);
        // Mint a fresh S-PIN session per EV op (a token doesn't survive several
        // writes), with one reauth retry if the access token has expired.
        const mint = async (): Promise<string> => {
          try {
            return await vwMintSpinSession(tokens, vehicle.uuid, spin);
          } catch (err) {
            if (!(err instanceof VwAuthError)) throw err;
            tokens = await reauth(db, env, account, true);
            return vwMintSpinSession(tokens, vehicle.uuid, spin);
          }
        };

        try {
          const state = await vwGetClimate(await mint(), tokens, vehicle.uuid);

          // Temp can only be set while climate is OFF, and it's its own async op.
          // Confirm it actually applied (a positive signal — VW rejects, doesn't
          // silently no-op, so a non-applying temp surfaces as an error) BEFORE
          // starting, so we never start at the wrong temp. The settings read also
          // spaces us past VW's EV rate-limit. The temp op gets a long retry budget
          // because the session below must record a temp the car really accepted —
          // a persistent busy here is a real failure the user has to see.
          if (state.targetTempF !== input.tempF) {
            if (state.on) {
              await retryOnBusy("climate stop (before temp change)", async () =>
                vwClimateStop(await mint(), vehicle.uuid),
              );
              await waitForClimateOff(await mint(), tokens, vehicle.uuid);
            }
            await retryOnBusy(
              "set climate temp",
              async () =>
                vwSetClimateTemp(await mint(), vehicle.uuid, input.tempF),
              { attempts: 5 },
            );
            await settleTempChange(
              tokens.accessToken,
              vehicle.uuid,
              input.tempF,
            );
          }

          // The start, by contrast, has a server-side fallback: the keepalive cron
          // starts climate for any active session whose car reports it off. If VW's
          // busy window outlasts the retries (common right after a temp change),
          // swallow the busy and let the cron start the car on its next tick (≤1
          // min) instead of bouncing "vehicle busy" to the user for a retry-by-hand
          // that IS the cron's job.
          try {
            const correlationId = await retryOnBusy("climate start", async () =>
              vwClimateStart(await mint(), vehicle.uuid),
            );
            console.log(
              `[vw] climate start accepted correlationId=${correlationId}`,
            );
          } catch (err) {
            if (!(err instanceof VwBusyError)) throw err;
            console.log(
              "[vw] climate start still busy — deferring to the keepalive cron",
            );
          }
        } catch (err) {
          mapVwError(err);
        }

        // Record the managed session; the cron keeps climate warm until it expires.
        await startClimateSession(db, vehicle.id, {
          tempF: input.tempF,
          expiresAt: Date.now() + input.durationMin * 60_000,
        });
        return { ok: true as const };
      },
    );
  },
);

const climateStop = os.vehicle.climateStop.handler(
  async ({ input, context }) => {
    const { db, env } = context;
    const userId = requireUser(context);
    const user = await getUser(db, userId);
    if (user.account === null)
      throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
    const account = user.account;
    const vehicle = pickVehicle(user, input.uuid);

    // A paused session means climate is already off (VW rejected the restart —
    // car in use); ending the session row is all a stop means here, and the VW
    // stop op would just fail or hang against a driving car. This is also the
    // user's escape hatch: without it a paused session couldn't be stopped
    // until the drive ended.
    const paused = await getActiveClimateSession(db, vehicle.id);
    if (paused !== null && paused.pausedAt !== null) {
      console.log(
        `[climate] session=${paused.id} vehicle=${vehicle.id} stopped by user while paused — skipping VW op`,
      );
      await endClimateSession(db, vehicle.id, "stopped");
      return { ok: true as const };
    }

    const spin = await requireSpin(env, account);

    return loggedOp(`climate stop vehicle=${vehicle.id}`, async () => {
      let tokens = await ensureTokens(db, env, account);
      const mint = async (): Promise<string> => {
        try {
          return await vwMintSpinSession(tokens, vehicle.uuid, spin);
        } catch (err) {
          if (!(err instanceof VwAuthError)) throw err;
          tokens = await reauth(db, env, account, true);
          return vwMintSpinSession(tokens, vehicle.uuid, spin);
        }
      };
      try {
        await confirmOp(
          tokens.accessToken,
          vehicle.uuid,
          await retryOnBusy("climate stop", async () =>
            vwClimateStop(await mint(), vehicle.uuid),
          ),
        );
      } catch (err) {
        mapVwError(err);
      }
      // End the managed session so the cron stops keeping it warm.
      await endClimateSession(db, vehicle.id, "stopped");
      return { ok: true as const };
    });
  },
);

const climateInfo = os.vehicle.climateInfo.handler(
  async ({ input, context }) => {
    const { db, env } = context;
    const userId = requireUser(context);
    const user = await getUser(db, userId);
    if (user.account === null)
      throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
    const vehicle = pickVehicle(user, input.uuid);

    const tokens = await ensureTokens(db, env, user.account);
    try {
      return {
        targetTempF: await vwGetClimateTargetTempF(
          tokens.accessToken,
          vehicle.uuid,
        ),
      };
    } catch (err) {
      if (!(err instanceof VwAuthError)) throw err;
      const fresh = await reauth(db, env, user.account, true);
      return {
        targetTempF: await vwGetClimateTargetTempF(
          fresh.accessToken,
          vehicle.uuid,
        ),
      };
    }
  },
);

const chargeStart = os.vehicle.chargeStart.handler(
  async ({ input, context }) => {
    const { db, env } = context;
    const userId = requireUser(context);
    const user = await getUser(db, userId);
    if (user.account === null)
      throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
    const account = user.account;
    const vehicle = pickVehicle(user, input.uuid);
    const spin = await requireSpin(env, account);

    let tokens = await ensureTokens(db, env, account);
    const mint = async (): Promise<string> => {
      try {
        return await vwMintSpinSession(tokens, vehicle.uuid, spin);
      } catch (err) {
        if (!(err instanceof VwAuthError)) throw err;
        tokens = await reauth(db, env, account, true);
        return vwMintSpinSession(tokens, vehicle.uuid, spin);
      }
    };
    try {
      await confirmOp(
        tokens.accessToken,
        vehicle.uuid,
        await retryOnBusy("charge start", async () =>
          vwChargeStart(await mint(), vehicle.uuid),
        ),
      );
    } catch (err) {
      mapVwError(err);
    }
    await snapshotNow(db, account, env, vehicle);
    return { ok: true as const };
  },
);

const chargeStop = os.vehicle.chargeStop.handler(async ({ input, context }) => {
  const { db, env } = context;
  const userId = requireUser(context);
  const user = await getUser(db, userId);
  if (user.account === null)
    throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
  const account = user.account;
  const vehicle = pickVehicle(user, input.uuid);
  const spin = await requireSpin(env, account);

  let tokens = await ensureTokens(db, env, account);
  const mint = async (): Promise<string> => {
    try {
      return await vwMintSpinSession(tokens, vehicle.uuid, spin);
    } catch (err) {
      if (!(err instanceof VwAuthError)) throw err;
      tokens = await reauth(db, env, account, true);
      return vwMintSpinSession(tokens, vehicle.uuid, spin);
    }
  };
  try {
    await confirmOp(
      tokens.accessToken,
      vehicle.uuid,
      await retryOnBusy("charge stop", async () =>
        vwChargeStop(await mint(), vehicle.uuid),
      ),
    );
  } catch (err) {
    mapVwError(err);
  }
  await snapshotNow(db, account, env, vehicle);
  return { ok: true as const };
});

const setChargeLimit = os.vehicle.setChargeLimit.handler(
  async ({ input, context }) => {
    const { db, env } = context;
    const userId = requireUser(context);
    const user = await getUser(db, userId);
    if (user.account === null)
      throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
    const account = user.account;
    const vehicle = pickVehicle(user, input.uuid);
    const spin = await requireSpin(env, account);

    let tokens = await ensureTokens(db, env, account);
    const mint = async (): Promise<string> => {
      try {
        return await vwMintSpinSession(tokens, vehicle.uuid, spin);
      } catch (err) {
        if (!(err instanceof VwAuthError)) throw err;
        tokens = await reauth(db, env, account, true);
        return vwMintSpinSession(tokens, vehicle.uuid, spin);
      }
    };
    try {
      await confirmOp(
        tokens.accessToken,
        vehicle.uuid,
        await retryOnBusy("set charge limit", async () =>
          vwSetChargeLimit(await mint(), vehicle.uuid, input.targetSoc),
        ),
      );
    } catch (err) {
      mapVwError(err);
    }
    await snapshotNow(db, account, env, vehicle);
    return { ok: true as const };
  },
);

const activity = os.vehicle.activity.handler(async ({ input, context }) => {
  const { db, env } = context;
  const userId = requireUser(context);
  const user = await getUser(db, userId);
  if (user.account === null)
    throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
  const account = user.account;
  const vehicle = pickVehicle(user, input.uuid);
  const spin = await requireSpin(env, account);

  // Tier-2 read: needs the S-PIN carnet bearer (the access token 403s).
  let tokens = await ensureTokens(db, env, account);
  const mint = async (): Promise<string> => {
    try {
      return await vwMintSpinSession(tokens, vehicle.uuid, spin);
    } catch (err) {
      if (!(err instanceof VwAuthError)) throw err;
      tokens = await reauth(db, env, account, true);
      return vwMintSpinSession(tokens, vehicle.uuid, spin);
    }
  };
  try {
    return { events: await vwGetActivity(await mint(), vehicle.uuid, 50) };
  } catch (err) {
    mapVwError(err);
  }
});

const messages = os.vehicle.messages.handler(async ({ input, context }) => {
  const { db, env } = context;
  const userId = requireUser(context);
  const user = await getUser(db, userId);
  if (user.account === null)
    throw new ORPCError("UNAUTHORIZED", { message: "not logged in" });
  const account = user.account;
  const vehicle = pickVehicle(user, input.uuid);
  const spin = await requireSpin(env, account);

  let tokens = await ensureTokens(db, env, account);
  const mint = async (): Promise<string> => {
    try {
      return await vwMintSpinSession(tokens, vehicle.uuid, spin);
    } catch (err) {
      if (!(err instanceof VwAuthError)) throw err;
      tokens = await reauth(db, env, account, true);
      return vwMintSpinSession(tokens, vehicle.uuid, spin);
    }
  };
  try {
    return {
      messages: await vwGetMessages(await mint(), tokens, vehicle.uuid, 50),
    };
  } catch (err) {
    mapVwError(err);
  }
});

/** Best-effort: read fresh status and store a snapshot so the UI reflects a
 *  just-issued change promptly (the cron would otherwise catch it within ~1m). */
async function snapshotNow(
  db: Db,
  account: StoredAccount,
  env: AppEnv,
  vehicle: StoredVehicle,
): Promise<void> {
  try {
    const tokens = await ensureTokens(db, env, account);
    await saveSnapshot(
      db,
      vehicle.id,
      await vwGetStatus(tokens.accessToken, vehicle.vin, vehicle.uuid),
    );
  } catch (err) {
    console.error("post-command snapshot failed", err);
  }
}

// A signed Apple Maps snapshot URL for the parked location. Pure signing — no
// VW traffic, no S-PIN; just gated to an authenticated user. The coords come
// from the client (which already has them from the snapshot live query); the
// signature authorizes only this one image.
const parkedMapUrl = os.vehicle.parkedMapUrl.handler(
  async ({ input, context }) => {
    requireUser(context);
    const url = await signSnapshotUrl(context.env, {
      lat: input.lat,
      lng: input.lng,
      widthPt: input.widthPt,
      heightPt: input.heightPt,
      scale: 2,
      dark: input.dark,
    });
    return { url };
  },
);

export const router = os.router({
  auth: { login, me, logout },
  vehicle: {
    refresh,
    command,
    climateStart,
    climateStop,
    climateInfo,
    chargeStart,
    chargeStop,
    setChargeLimit,
    activity,
    messages,
    parkedMapUrl,
  },
});

export type AppRouter = typeof router;
