/** Keeping a stored VW account's tokens usable (refresh or re-login). */
import { unseal } from "./crypto";
import type { AppEnv } from "./env";
import { integrityProvider, IntegrityUnavailableError } from "./integrity";
import {
  clearLoginFailures,
  recordLoginFailure,
  type Db,
  type StoredAccount,
} from "./store";
import {
  VwAuthError,
  VwCommandError,
  vwLogin,
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
export async function renewAccount(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  forceRelogin: boolean,
): Promise<VwTokens> {
  let tokens: VwTokens | null = null;
  // VW's refresh grant now also requires the original login code_verifier, so a
  // session stored without one can't refresh — go straight to a full login
  // (which re-stores a verifier).
  if (
    account.tokens.refreshToken !== null &&
    account.tokens.codeVerifier !== null
  ) {
    try {
      tokens = await vwRefresh(
        account.tokens.refreshToken,
        account.tokens.codeVerifier,
        integrityProvider(env),
      );
      console.log(`[auth] account=${account.id} token refresh ok`);
      // A working refresh means the session is healthy again — re-open the
      // breaker so the next genuine need for a login isn't blocked.
      await clearLoginFailures(db, account);
    } catch (err) {
      if (!(err instanceof VwAuthError)) throw err;
      console.log(
        `[auth] account=${account.id} token refresh failed (${err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }
  if (tokens === null) {
    if (account.login.blockedUntil > Date.now()) {
      throw new VwLoginBlockedError(
        "VW password login is temporarily backed off after failed attempts.",
      );
    }
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
      tokens = await vwLogin(
        creds.username,
        creds.password,
        integrityProvider(env),
      );
      console.log(`[auth] account=${account.id} VW password login ok`);
      await clearLoginFailures(db, account);
    } catch (err) {
      if (err instanceof IntegrityUnavailableError) throw err;
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
  return tokens;
}

/** All isolates and cron/client callers converge on one serialized session. */
export async function reauth(
  _db: Db,
  env: AppEnv,
  account: StoredAccount,
  rejected: boolean,
): Promise<VwTokens> {
  const stub = env.AUTH_SESSIONS.get(env.AUTH_SESSIONS.idFromName(account.id));
  const response = await stub.fetch("https://auth-session/renew", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      previousAccessToken: account.tokens.accessToken,
      rejected,
    }),
  });
  if (!response.ok) {
    const body = await response.json<{ error?: string }>();
    if (body.error === "blocked")
      throw new VwLoginBlockedError(
        "VW login temporarily backed off. Please try later.",
      );
    if (body.error === "auth")
      throw new VwAuthError("VW session could not be renewed.");
    throw new IntegrityUnavailableError();
  }
  const tokens = await response.json<VwTokens>();
  account.tokens = tokens;
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

/** Serialize all S-PIN challenges per account, including commands and cron. */
export async function ensureCarnetToken(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  uuid: string,
  spin: string,
  opts: { force?: boolean } = {},
): Promise<string> {
  await ensureTokens(db, env, account);
  const stub = env.AUTH_SESSIONS.get(env.AUTH_SESSIONS.idFromName(account.id));
  const mint = () =>
    stub.fetch("https://auth-session/carnet", {
      method: "POST",
      body: JSON.stringify({
        accountId: account.id,
        uuid,
        spin,
        force: opts.force === true,
      }),
    });
  let response = await mint();
  if (response.status === 401) {
    await reauth(db, env, account, true);
    response = await mint();
  }
  const body = await response.json<{
    token?: string;
    expiresAt?: number;
    error?: string;
  }>();
  if (!response.ok || !body.token || !body.expiresAt) {
    throw new VwCommandError(body.error ?? "VW S-PIN session is unavailable.");
  }
  account.carnetTokens[uuid] = { token: body.token, expiresAt: body.expiresAt };
  return body.token;
}
