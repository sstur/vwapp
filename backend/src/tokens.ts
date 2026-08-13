/** Keeping a stored VW account's tokens usable (refresh or re-login). */
import { unseal } from "./crypto";
import type { AppEnv } from "./env";
import {
  clearLoginFailures,
  recordLoginFailure,
  saveCarnetToken,
  updateTokens,
  type Db,
  type StoredAccount,
} from "./store";
import {
  jwtExpiryMs,
  VwAuthError,
  vwLogin,
  vwMintSpinSession,
  vwRefresh,
  type VwTokens,
} from "./vw/client";

/** Thrown instead of attempting a password login while the breaker is armed. */
export class VwLoginBlockedError extends Error {}

/**
 * How long to refuse password logins after `failures` consecutive failures:
 * 15m, 30m, 1h, 2h, 4h, 8h, then 12h forever. VW's throttle tolerates ~8-10
 * logins in quick succession, so even the first step is far inside the limit,
 * while a permanently broken auth (a changed password, or VW tightening the
 * protocol) settles at 2 attempts a day instead of 1440.
 */
export function loginBackoffMs(failures: number): number {
  const FIFTEEN_MIN = 15 * 60_000;
  const TWELVE_HOURS = 12 * 60 * 60_000;
  return Math.min(FIFTEEN_MIN * 2 ** Math.max(0, failures - 1), TWELVE_HOURS);
}

/**
 * Get fresh VW tokens, refreshing / re-logging-in as needed, and persist them.
 *
 * Every transition logs an `[auth]` line: full password logins are VW's
 * throttled resource (~8-10 in quick succession locks the account out for a
 * while), so the log must show exactly when one happened and what triggered
 * it. Never log credentials or tokens — account ids only.
 *
 * Password logins additionally go through a persisted circuit breaker
 * (`account.login`): consecutive failures push an exponentially growing block
 * window, and while it is armed this throws VwLoginBlockedError WITHOUT
 * touching VW. Without it, a dead VW session turns the every-minute cron into
 * ~60 password logins an hour — how 2026-08-13's outage nearly cost the
 * account. The breaker is deliberately NOT armed by refresh failures (the
 * refresh grant isn't the throttled resource); only real logins count.
 */
export async function reauth(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  forceRelogin: boolean,
): Promise<VwTokens> {
  // Armed breaker short-circuits the WHOLE reauth, refresh included: the
  // breaker only ever arms after a login that itself followed a failed
  // refresh, so retrying the refresh every tick just adds 1440 doomed calls a
  // day to VW's token endpoint. One refresh+login attempt per window instead.
  if (account.login.blockedUntil > Date.now()) {
    const mins = Math.ceil((account.login.blockedUntil - Date.now()) / 60_000);
    const msg =
      `VW auth blocked for another ${String(mins)}m after ` +
      `${String(account.login.failures)} consecutive failed password logins`;
    console.log(`[auth] account=${account.id} ${msg}`);
    throw new VwLoginBlockedError(msg);
  }
  let tokens: VwTokens | null = null;
  // VW's refresh grant now also requires the original login code_verifier, so a
  // session stored without one can't refresh — go straight to a full login
  // (which re-stores a verifier).
  if (
    !forceRelogin &&
    account.tokens.refreshToken !== null &&
    account.tokens.codeVerifier !== null
  ) {
    try {
      tokens = await vwRefresh(
        account.tokens.refreshToken,
        account.tokens.codeVerifier,
      );
      console.log(`[auth] account=${account.id} token refresh ok`);
      // A working refresh means the session is healthy again — re-open the
      // breaker so the next genuine need for a login isn't blocked.
      await clearLoginFailures(db, account);
    } catch (err) {
      console.log(
        `[auth] account=${account.id} token refresh failed (${err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }
  if (tokens === null) {
    const trigger = forceRelogin
      ? "forced"
      : account.tokens.refreshToken === null
        ? "no refresh token"
        : account.tokens.codeVerifier === null
          ? "no code_verifier"
          : "refresh failed";
    console.log(
      `[auth] account=${account.id} VW password login (trigger=${trigger})`,
    );
    const credsJson = await unseal(env.CREDS_ENC_KEY, account.sealed);
    const creds = JSON.parse(credsJson) as {
      username: string;
      password: string;
    };
    try {
      tokens = await vwLogin(creds.username, creds.password);
      console.log(`[auth] account=${account.id} VW password login ok`);
      await clearLoginFailures(db, account);
    } catch (err) {
      const blockedUntil =
        Date.now() + loginBackoffMs(account.login.failures + 1);
      await recordLoginFailure(db, account, blockedUntil);
      console.error(
        `[auth] account=${account.id} VW password login FAILED: ` +
          `${err instanceof Error ? err.message : "unknown"} — ` +
          `attempt ${String(account.login.failures)}, ` +
          `next allowed ${new Date(blockedUntil).toISOString()}`,
      );
      throw err;
    }
  }
  await updateTokens(db, account.id, tokens);
  return tokens;
}

/** The stored tokens if the access token is still valid, else a fresh set. */
export async function ensureTokens(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
): Promise<VwTokens> {
  if (account.tokens.expiresAt > Date.now() + 60_000) return account.tokens;
  return reauth(db, env, account, false);
}

/** Re-mint this long before a cached carnet token actually expires. */
const CARNET_MARGIN_MS = 3 * 60_000;
/** Fallback lifetime if the minted token carries no `exp` (VW's is 30 min). */
const CARNET_FALLBACK_TTL_MS = 25 * 60_000;

/**
 * A usable per-vehicle carnet (S-PIN session) token, minted only when the
 * cached one is missing or near expiry.
 *
 * VW now gates the *status reads* behind this token (see vwGetStatus), so the
 * every-minute cron would otherwise mint one per tick — 60 S-PIN challenges an
 * hour against an endpoint whose `remainingTries` counter guards a lockout that
 * needs a dealer reset. VW's tokens live 30 minutes, so caching them on the
 * account cuts that to ~2/hour/vehicle. Pass `force` after a 401 to bypass the
 * cache and re-mint.
 */
export async function ensureCarnetToken(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  uuid: string,
  spin: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  const cached = account.carnetTokens[uuid];
  if (
    opts.force !== true &&
    cached !== undefined &&
    cached.expiresAt > Date.now() + CARNET_MARGIN_MS
  )
    return cached.token;

  const tokens = await ensureTokens(db, env, account);
  let token: string;
  try {
    token = await vwMintSpinSession(tokens, uuid, spin);
  } catch (err) {
    // Access token died between the expiry check and the mint — re-login once.
    if (!(err instanceof VwAuthError)) throw err;
    token = await vwMintSpinSession(
      await reauth(db, env, account, true),
      uuid,
      spin,
    );
  }
  const expiresAt = jwtExpiryMs(token) ?? Date.now() + CARNET_FALLBACK_TTL_MS;
  await saveCarnetToken(db, account, uuid, { token, expiresAt });
  console.log(
    `[auth] account=${account.id} vehicle=${uuid} minted carnet token (expires ${new Date(expiresAt).toISOString()})`,
  );
  return token;
}
