/**
 * Cron: fetch live status from VW for every stored account and write
 * snapshots. InstantDB then pushes them to subscribed apps in real time —
 * this is what makes the dashboard update without the app asking.
 */
import { unseal } from "./crypto";
import type { AppEnv } from "./env";
import { readStatus } from "./status";
import {
  endClimateSession,
  latestParkedAt,
  listAccounts,
  listActiveClimateSessions,
  pruneSnapshots,
  saveSnapshot,
  updateClimateSession,
  type Db,
} from "./store";
import { ensureTokens } from "./tokens";
import {
  vwAwaitCommandResult,
  VwBusyError,
  vwClimateStart,
  vwClimateStop,
  VwCommandError,
  vwGetClimate,
  vwMintSpinSession,
} from "./vw/client";

const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function pollAllVehicles(db: Db, env: AppEnv): Promise<void> {
  const accounts = await listAccounts(db);
  let polled = 0;
  let written = 0;
  for (const { account, vehicles } of accounts) {
    try {
      // Status reads are S-PIN gated now, so an account with no stored S-PIN
      // simply can't be polled (it can still be used for anything that only
      // needs the access token). Log once per tick rather than throwing.
      const creds = JSON.parse(
        await unseal(env.CREDS_ENC_KEY, account.sealed),
      ) as { spin?: string };
      if (creds.spin === undefined || creds.spin === "") {
        console.log(
          `[cron] account=${account.id} skipped: no stored S-PIN (status reads are S-PIN gated)`,
        );
        continue;
      }
      for (const vehicle of vehicles) {
        const status = await readStatus(db, env, account, vehicle, creds.spin);
        if (await saveSnapshot(db, vehicle.id, status)) written++;
        polled++;
      }
    } catch (err) {
      // One bad account (e.g. changed VW password) must not block the rest.
      console.error(`[cron] poll failed for account ${account.id}`, err);
    }
  }
  const pruned = await pruneSnapshots(db, Date.now() - SNAPSHOT_RETENTION_MS);
  // Heartbeat: a gap in these lines means the cron itself stopped firing —
  // otherwise indistinguishable from "nothing changed" until data goes stale.
  console.log(
    `[cron] poll tick: ${String(polled)} vehicles / ${String(accounts.length)} accounts, ${String(written)} snapshots written${pruned > 0 ? `, ${String(pruned)} pruned` : ""}`,
  );
}

/** While paused, attempt a start anyway this often — a bounded fallback in
 *  case the parked-event signal is late or missing (a repeat rejection just
 *  re-arms the pause). Worst case is the old every-tick spam at 1/10 rate. */
const PAUSE_RETRY_MS = 10 * 60 * 1000;

/**
 * Keep user-requested climate sessions alive. For each active session: stop at
 * expiry; otherwise, if the car has auto-stopped climate (its ~30-min default),
 * restart it — reactive, because re-issuing start while ON does NOT extend the
 * timer. Each EV op is S-PIN-session (carnet) gated; VwBusyError (the EV rate
 * limit) just means "a prior op is in flight" — skip and retry next minute.
 *
 * Driving pauses a session instead of failing it: VW rejects starts with
 * "ignition on" while the car is in use, so a rejection mentioning ignition
 * sets `pausedAt` and the keepalive stops issuing starts (no doomed-request
 * spam in VW's activity log) until the status poller records a parking event
 * NEWER than the pause — or, as a fallback, until PAUSE_RETRY_MS elapses.
 *
 * Every state transition logs a `[climate]` line with the session id (and
 * correlationId for VW commands, cross-referenceable with VW's own activity
 * log) — observability is enabled in wrangler.jsonc, so these persist in
 * Workers Logs and a session's history can be reassembled after the fact.
 */
export async function runClimateKeepalive(db: Db, env: AppEnv): Promise<void> {
  const sessions = await listActiveClimateSessions(db);
  for (const { session, vehicle, account } of sessions) {
    const slog = (msg: string) => {
      console.log(
        `[climate] session=${session.id} vehicle=${vehicle.id} ${msg}`,
      );
    };
    try {
      const tokens = await ensureTokens(db, env, account);
      const creds = JSON.parse(
        await unseal(env.CREDS_ENC_KEY, account.sealed),
      ) as { spin?: string };
      if (creds.spin === undefined || creds.spin === "") {
        slog("failed: no stored S-PIN");
        await endClimateSession(db, vehicle.id, "failed");
        continue;
      }

      // Paused (car was being driven): expiry still ends the session below,
      // but otherwise skip everything — including the S-PIN mint — until the
      // car has parked again or the retry fallback comes due.
      if (session.pausedAt !== null && Date.now() < session.expiresAt) {
        const parkedAt = await latestParkedAt(db, vehicle.id);
        const parkedSincePause =
          parkedAt !== null && parkedAt > session.pausedAt;
        const retryDue = Date.now() - session.pausedAt >= PAUSE_RETRY_MS;
        if (!parkedSincePause && !retryDue) continue; // still paused — no log (1/min spam)
        slog(
          `resume attempt: ${
            parkedSincePause
              ? `parked event at ${new Date(parkedAt).toISOString()} > pausedAt ${new Date(session.pausedAt).toISOString()}`
              : `no parked event, retry fallback after ${String(Math.round((Date.now() - session.pausedAt) / 60000))}m`
          }`,
        );
      }

      const carnet = await vwMintSpinSession(tokens, vehicle.uuid, creds.spin);

      if (Date.now() >= session.expiresAt) {
        slog(
          `expired (expiresAt=${new Date(session.expiresAt).toISOString()}) — stopping`,
        );
        await vwClimateStop(carnet, vehicle.uuid);
        await endClimateSession(db, vehicle.id, "expired");
        continue;
      }

      const state = await vwGetClimate(carnet, tokens, vehicle.uuid);
      if (!state.on) {
        // Car auto-stopped before our session expiry — restart it, and read
        // the command's terminal result so an "ignition on" rejection pauses
        // the session rather than repeating every tick.
        const correlationId = await vwClimateStart(carnet, vehicle.uuid);
        slog(`start issued correlationId=${correlationId}`);
        try {
          const { confirmed } = await vwAwaitCommandResult(
            carnet,
            vehicle.uuid,
            correlationId,
            { attempts: 4, intervalMs: 2500 },
          );
          slog(
            confirmed
              ? `start confirmed correlationId=${correlationId}`
              : `start unconfirmed within window correlationId=${correlationId} — assuming accepted`,
          );
        } catch (err) {
          if (err instanceof VwCommandError && /ignition/i.test(err.message)) {
            slog(`paused: start rejected, ignition on (${err.message})`);
            await updateClimateSession(db, session.id, {
              pausedAt: Date.now(),
              error: "Vehicle is on — climate will resume after parking.",
            });
            continue;
          }
          // Other terminal failures: recorded (with VW's code) by the catch
          // below. If a real ignition rejection lands here, its logged code
          // tells us what string to match instead.
          throw err;
        }
        await updateClimateSession(db, session.id, {
          lastStartAt: Date.now(),
          remainingMin: 0,
          pausedAt: null,
        });
      } else {
        if (session.pausedAt !== null)
          slog("pause cleared: climate observed running");
        await updateClimateSession(db, session.id, {
          remainingMin: state.remainingMin ?? 0,
          // Climate running means nothing blocks it — drop any stale pause.
          ...(session.pausedAt !== null ? { pausedAt: null } : {}),
        });
      }
    } catch (err) {
      if (err instanceof VwBusyError) {
        slog("skipped: EV channel busy (prior op in flight)");
        continue; // retry next tick
      }
      console.error(
        `[climate] session=${session.id} keepalive failed for vehicle ${vehicle.id}`,
        err,
      );
      await updateClimateSession(db, session.id, {
        error: err instanceof Error ? err.message : "keepalive error",
      }).catch(() => undefined);
    }
  }
}
