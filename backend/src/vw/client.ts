/**
 * VW North America (Car-Net / myVW US) client — Workers-native port of the
 * verified PoC. Uses Web Crypto + a tiny cookie jar (no node:crypto, no
 * tough-cookie) so it runs unchanged on the Cloudflare Workers runtime.
 *
 * Flow: OAuth2 auth-code + PKCE(S256), public client, no secret.
 *   GET {API}/oidc/v1/authorize -> 302 to identity.na.vwgroup.io login
 *   -> identifier-first HTML scrape -> kombi:///login?code=… -> token exchange.
 */
import type { StatusDTO, VehicleDTO } from "@vwapp/contract";
import type { IntegrityProvider } from "../integrity";

const API = "https://b-h-s.spr.us00.p.con-veh.net";
const IDP = "https://identity.na.vwgroup.io";
const DEVICE_CLIENT = "59992128-69a9-42c3-8621-7942041ba824_MYVW_ANDROID";
const IDP_CLIENT = "b680e751-7e1f-4008-8ec1-3a528183d215@apps_vw-dilab_com";
const REDIRECT_URI = "kombi:///login";
const SCOPE = "openid";
const APP_UA = "MyVW/1.0 Android";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/74.0.3729.185 Mobile Safari/537.36";
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export interface VwTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** epoch ms */
  expiresAt: number;
  /**
   * The PKCE code_verifier from the original login. VW now requires it to be
   * replayed on the refresh_token grant (the stock app persists and replays the
   * login verifier — APK xr0.java). Null for sessions stored before this was
   * tracked; those can't refresh and fall back to a full login (which re-stores it).
   */
  codeVerifier: string | null;
}

export class VwAuthError extends Error {}
/** Transport/server failures are not evidence that credentials are invalid. */
export class VwUnavailableError extends Error {}
/** A remote command was reachable but rejected (bad S-PIN, lockout, refusal). */
export class VwCommandError extends Error {}
/** VW is still processing a previous EV op (EV_THRESHOLD_EXCEEDED) — retry later. */
export class VwBusyError extends Error {}

// ---- tiny cookie jar -------------------------------------------------------
interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
}

class CookieJar {
  private cookies: StoredCookie[] = [];

  ingest(res: Response, url: string): void {
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    for (const sc of setCookies) this.set(sc, url);
  }

  private set(setCookie: string, url: string): void {
    const u = new URL(url);
    const [nv, ...attrs] = setCookie.split(";");
    if (nv === undefined) return;
    const eq = nv.indexOf("=");
    if (eq < 0) return;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    let domain = u.hostname.toLowerCase();
    let hostOnly = true;
    let path = "/";
    for (const attr of attrs) {
      const ai = attr.indexOf("=");
      const key = (ai < 0 ? attr : attr.slice(0, ai)).trim().toLowerCase();
      const val = ai < 0 ? "" : attr.slice(ai + 1).trim();
      if (key === "domain" && val) {
        domain = val.replace(/^\./, "").toLowerCase();
        hostOnly = false;
      } else if (key === "path" && val) {
        path = val;
      }
    }
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path),
    );
    this.cookies.push({ name, value, domain, path, hostOnly });
  }

  header(url: string): string {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname || "/";
    return this.cookies
      .filter((c) => {
        const domainOk = c.hostOnly
          ? host === c.domain
          : host === c.domain || host.endsWith(`.${c.domain}`);
        const prefix = c.path.endsWith("/") ? c.path : `${c.path}/`;
        const pathOk =
          c.path === "/" || path === c.path || path.startsWith(prefix);
        return domainOk && pathOk;
      })
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
}

// ---- crypto helpers (Web Crypto only) --------------------------------------
const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function randomHex(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

function base64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return base64Url(digest);
}

async function sha512Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

/** The myVW user id (OIDC `sub`) decoded from the id_token payload. */
function userIdFromIdToken(idToken: string): string {
  const part = idToken.split(".")[1];
  if (part === undefined) throw new VwAuthError("malformed id_token");
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const sub = (JSON.parse(json) as { sub?: string }).sub;
  if (sub === undefined) throw new VwAuthError("id_token has no sub claim");
  return sub;
}

// ---- VW response shapes (loose; cast from JSON) ----------------------------
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
}
interface RawVehicle {
  vin?: string;
  vehicleId?: string;
  uuid?: string;
  vehicleNickName?: string;
  modelName?: string;
}
interface GarageResponse {
  data?: { vehicles?: RawVehicle[] };
  vehicles?: RawVehicle[];
}
interface RvsResponse {
  data?: {
    currentMileage?: number;
    timestamp?: number;
    powerStatus?: {
      cruiseRange?: number;
      cruiseRangeUnits?: string;
      odometer?: number;
    };
    exteriorStatus?: {
      secure?: string;
      // Values are mostly strings ("OPEN"/"LOCKED"/…) but include a numeric
      // *Timestamp field, so type loosely and filter in the helpers.
      doorStatus?: Record<string, unknown>;
      doorLockStatus?: Record<string, unknown>;
      windowStatus?: Record<string, unknown>;
    };
    lastParkedLocation?: {
      latitude?: number;
      longitude?: number;
      timestamp?: number;
    };
  };
}

/** "frontLeft" -> "front left"; passthrough for trunk/hood. */
function friendlyClosure(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Closure-status entries that are real string states (skips the timestamp field). */
function closureStates(
  status: Record<string, unknown> | undefined,
): [string, string][] {
  if (status === undefined) return [];
  return Object.entries(status).filter(
    (e): e is [string, string] =>
      typeof e[1] === "string" && !e[0].toLowerCase().includes("timestamp"),
  );
}

/** Friendly names of closures in `OPEN` state (ignores NOTAVAILABLE/CLOSED). */
function openNames(status: Record<string, unknown> | undefined): string[] {
  return closureStates(status)
    .filter(([, v]) => v.toUpperCase() === "OPEN")
    .map(([k]) => friendlyClosure(k));
}

/** Doors with a lock state present but not LOCKED (rare; ignores NOTAVAILABLE). */
function unlockedNames(status: Record<string, unknown> | undefined): string[] {
  return closureStates(status)
    .filter(
      ([, v]) =>
        v.toUpperCase() !== "LOCKED" && v.toUpperCase() !== "NOTAVAILABLE",
    )
    .map(([k]) => friendlyClosure(k));
}

/**
 * The numeric `*Timestamp` entry VW mixes into each closure-status map —
 * when that category last updated. Normalized to epoch ms in case any
 * endpoint reports seconds.
 */
function closureTimestamp(
  status: Record<string, unknown> | undefined,
): number | null {
  if (status === undefined) return null;
  for (const [k, v] of Object.entries(status)) {
    if (k.toLowerCase().includes("timestamp") && typeof v === "number")
      return epochMs(v);
  }
  return null;
}

/** Epoch seconds → ms (values before ~2001 in ms can't occur here). */
function epochMs(t: number): number {
  return t < 1e12 ? t * 1000 : t;
}
interface ChargeResponse {
  data?: {
    carCapturedTimestamp?: number;
    batteryStatus?: { currentSOCPct?: number; carCapturedTimestamp?: number };
    chargingStatus?: {
      currentChargeState?: string;
      currentSOCPct?: number;
      chargePower?: number;
      remainingChargingTimeToComplete?: number;
    };
    plugStatus?: { plugConnectionState?: string; plugLockState?: string };
    chargeSettings?: { targetSOCPercentage?: number };
  };
}

interface FollowResult {
  res: Response;
  finalUrl: string;
  body: string;
  callbackUrl?: string;
}

// ---- login (cookie jar + manual redirects) ---------------------------------
async function follow(
  jar: CookieJar,
  url: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
  maxRedirects = 30,
): Promise<FollowResult> {
  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;
  let extraHeaders = init.headers ?? {};

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const cookie = jar.header(current);
    const headers: Record<string, string> = {
      "user-agent": BROWSER_UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "x-requested-with": "com.volkswagen.weconnect",
      ...extraHeaders,
      ...(cookie ? { cookie } : {}),
    };
    const res = await fetch(current, {
      method,
      headers,
      body: body ?? null,
      redirect: "manual",
    });
    jar.ingest(res, current);

    if (REDIRECT_CODES.has(res.status)) {
      const loc = res.headers.get("location");
      if (loc === null)
        throw new VwAuthError(
          `redirect ${String(res.status)} without Location`,
        );
      if (loc.startsWith("kombi://"))
        return { res, finalUrl: current, body: "", callbackUrl: loc };
      current = new URL(loc, current).toString();
      if (res.status === 302 || res.status === 303) {
        method = "GET";
        body = undefined;
        // Only content-type is ever passed through; drop it when downgrading to GET.
        extraHeaders = {};
      }
      continue;
    }
    return { res, finalUrl: current, body: await res.text() };
  }
  throw new VwAuthError("too many redirects");
}

function extractHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<input[^>]*>/gi) ?? []) {
    if (!/type=["']hidden["']/i.test(tag)) continue;
    const name = /name=["']([^"']*)["']/i.exec(tag)?.[1];
    const value = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (name !== undefined) out[name] = value;
  }
  return out;
}

function matchOne(s: string, re: RegExp, what: string): string {
  const m = re.exec(s);
  if (m?.[1] === undefined)
    throw new VwAuthError(`could not find ${what} in login page`);
  return m[1];
}

function mergeUrlParams(url: string): URLSearchParams {
  const u = new URL(url);
  const params = new URLSearchParams();
  u.searchParams.forEach((v, k) => {
    params.set(k, v);
  });
  if (u.hash)
    new URLSearchParams(u.hash.slice(1)).forEach((v, k) => {
      params.set(k, v);
    });
  return params;
}

function assertNoTerms(body: string): void {
  if (/terms-and-conditions|termsAndConditions/i.test(body))
    throw new VwAuthError(
      "VW requires you to accept new Terms & Conditions in the myVW app first.",
    );
}

function tokensFrom(t: TokenResponse, codeVerifier: string | null): VwTokens {
  const accessToken = t.access_token ?? t.accessToken;
  if (accessToken === undefined)
    throw new VwAuthError("token response had no access_token");
  return {
    accessToken,
    refreshToken: t.refresh_token ?? t.refreshToken ?? null,
    idToken: t.id_token ?? t.idToken ?? null,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    codeVerifier,
  };
}

/** Full interactive login with username/password → tokens. */
export async function vwLogin(
  username: string,
  password: string,
  integrity: IntegrityProvider,
): Promise<VwTokens> {
  const jar = new CookieJar();
  const codeVerifier = randomHex(64).toUpperCase();
  const codeChallenge = await sha256Base64Url(codeVerifier);
  // Fail before submitting credentials if the phone/bridge is unavailable.
  const integrityToken = await integrity(codeVerifier);

  const authUrl =
    `${API}/oidc/v1/authorize?` +
    new URLSearchParams({
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      prompt: "login",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: randomHex(16),
      response_type: "code",
      client_id: DEVICE_CLIENT,
    }).toString();

  const emailPage = await follow(jar, authUrl);
  let callbackUrl = emailPage.callbackUrl;

  if (callbackUrl === undefined) {
    assertNoTerms(emailPage.body);
    const emailForm = extractHiddenInputs(emailPage.body);
    if (!("_csrf" in emailForm) || !("hmac" in emailForm))
      throw new VwAuthError(
        "could not parse VW email login form (markup changed)",
      );

    const pwPage = await follow(
      jar,
      `${IDP}/signin-service/v1/${IDP_CLIENT}/login/identifier`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...emailForm, email: username }).toString(),
      },
    );
    callbackUrl = pwPage.callbackUrl;

    if (callbackUrl === undefined) {
      assertNoTerms(pwPage.body);
      const pwForm = {
        _csrf: matchOne(pwPage.body, /csrf_token['":\s]+([\w.-]+)/i, "_csrf"),
        relayState: matchOne(
          pwPage.body,
          /"relayState":"([^"]+)"/i,
          "relayState",
        ),
        hmac: matchOne(pwPage.body, /"hmac":"([^"]+)"/i, "hmac"),
        email: username,
        password,
      };
      const authRes = await follow(
        jar,
        `${IDP}/signin-service/v1/${IDP_CLIENT}/login/authenticate`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(pwForm).toString(),
        },
      );
      callbackUrl = authRes.callbackUrl;
      if (callbackUrl === undefined) {
        if (/password_invalid|wrong-email-credentials/i.test(authRes.body))
          throw new VwAuthError("Wrong email or password.");
        if (/login\.error\.throttled/i.test(authRes.body))
          throw new VwAuthError("VW login throttled — wait and retry.");
        assertNoTerms(authRes.body);
        throw new VwAuthError(
          `Login did not reach the callback (HTTP ${String(authRes.res.status)}).`,
        );
      }
    }
  }

  const code = mergeUrlParams(callbackUrl).get("code");
  if (code === null)
    throw new VwAuthError("callback had no authorization code");

  const res = await fetch(`${API}/oidc/v1/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": APP_UA,
    },
    body: new URLSearchParams({
      play_integrity_token: integrityToken,
      grant_type: "authorization_code",
      code,
      client_id: DEVICE_CLIENT,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!res.ok)
    throw new VwAuthError(`token exchange failed: ${String(res.status)}`);
  const body: unknown = await res.json();
  return tokensFrom(body as TokenResponse, codeVerifier);
}

/**
 * Refresh tokens with a refresh_token. Throws if the refresh token is dead.
 * VW now requires BOTH a `play_integrity_token` and the original login's
 * `code_verifier` on this grant (without the verifier the server returns 400
 * "Internal Service validation failure") — so a session stored without a
 * verifier (codeVerifier === null) can't refresh; the caller should skip
 * straight to a full login for those.
 */
export async function vwRefresh(
  refreshToken: string,
  codeVerifier: string | null,
  integrity: IntegrityProvider,
): Promise<VwTokens> {
  const integrityToken = await integrity(refreshToken);
  const res = await fetch(`${API}/oidc/v1/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": APP_UA,
    },
    body: new URLSearchParams({
      play_integrity_token: integrityToken,
      grant_type: "refresh_token",
      client_id: DEVICE_CLIENT,
      refresh_token: refreshToken,
      ...(codeVerifier !== null ? { code_verifier: codeVerifier } : {}),
    }).toString(),
  });
  if (res.status === 429 || res.status >= 500)
    throw new VwUnavailableError(
      `VW token service unavailable (${String(res.status)})`,
    );
  if (!res.ok)
    throw new VwAuthError(`token refresh failed: ${String(res.status)}`);
  const body: unknown = await res.json();
  const tokens = tokensFrom(body as TokenResponse, codeVerifier);
  // Car-Net sometimes omits a new refresh token; keep the old one.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

// ---- authenticated API -----------------------------------------------------
async function apiGet<T>(bearer: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      "user-agent": APP_UA,
    },
  });
  if (res.status === 401) throw new VwAuthError("unauthorized");
  if (!res.ok) throw new Error(`GET ${path} -> ${String(res.status)}`);
  const body: unknown = await res.json();
  return body as T;
}

export async function vwGetVehicles(
  accessToken: string,
): Promise<VehicleDTO[]> {
  const data = await apiGet<GarageResponse>(accessToken, "/account/v1/garage");
  const raw = data.data?.vehicles ?? data.vehicles ?? [];
  return raw
    .map((v): VehicleDTO | null => {
      const uuid = v.vehicleId ?? v.uuid;
      if (uuid === undefined || v.vin === undefined) return null;
      return {
        vin: v.vin,
        uuid,
        nickname: v.vehicleNickName ?? null,
        model: v.modelName ?? null,
      };
    })
    .filter((v): v is VehicleDTO => v !== null);
}

/**
 * Read live status. VERIFIED LIVE 2026-07-30: both reads are now **S-PIN
 * (carnet) gated** — with the plain access token `/rvs` and `/ev` return
 * `403 USER_NOT_AUTHORIZED` (from `vehiclestatusservice` / `EVServices`), even
 * though the account's privileges list VehicleStatus/EV as AVAILABLE. VW moved
 * these reads onto the same carnet-vehicle-token auth that lock/unlock and
 * force-refresh already use (the stock app's rvs client sits on that token too
 * — APK `defpackage/gig.java`). Pass a carnetVehicleToken from
 * `vwMintSpinSession`; a 401 means it expired — re-mint and retry.
 */
export async function vwGetStatus(
  carnetToken: string,
  vin: string,
  uuid: string,
): Promise<StatusDTO> {
  const [rvs, charge] = await Promise.all([
    apiGet<RvsResponse>(carnetToken, `/rvs/v1/vehicle/${uuid}`),
    apiGet<ChargeResponse>(
      carnetToken,
      `/ev/v1/vehicle/${uuid}/charge/summary`,
    ),
  ]);
  return toStatusDTO(vin, rvs, charge);
}

/** A JWT's `exp` claim as epoch ms, or null if absent/unparseable. */
export function jwtExpiryMs(token: string): number | null {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function toStatusDTO(
  vin: string,
  rvs: RvsResponse,
  charge: ChargeResponse,
): StatusDTO {
  const ext = rvs.data?.exteriorStatus;
  const power = rvs.data?.powerStatus;
  const bat = charge.data?.batteryStatus;
  const chg = charge.data?.chargingStatus;
  const plug = charge.data?.plugStatus;
  const plugConn = plug?.plugConnectionState?.toLowerCase();

  // Normalize range to km regardless of the unit VW reports.
  const rangeRaw = power?.cruiseRange ?? null;
  const rangeKm =
    rangeRaw === null
      ? null
      : power?.cruiseRangeUnits === "MI"
        ? Math.round(rangeRaw * 1.609344)
        : rangeRaw;

  return {
    vin,
    soc: bat?.currentSOCPct ?? chg?.currentSOCPct ?? null,
    chargeState: chg?.currentChargeState ?? null,
    chargePowerKw: chg?.chargePower ?? null,
    minutesToFull: chg?.remainingChargingTimeToComplete ?? null,
    pluggedIn: plugConn === undefined ? null : plugConn === "connected",
    plugLocked:
      plug?.plugLockState === undefined
        ? null
        : plug.plugLockState.toLowerCase() === "locked",
    targetSoc: charge.data?.chargeSettings?.targetSOCPercentage ?? null,
    locked: ext?.secure === undefined ? null : ext.secure === "SECURE",
    openDoors: openNames(ext?.doorStatus),
    openWindows: openNames(ext?.windowStatus),
    unlockedDoors: unlockedNames(ext?.doorLockStatus),
    rangeKm,
    odometerKm: rvs.data?.currentMileage ?? power?.odometer ?? null,
    parkedLat: rvs.data?.lastParkedLocation?.latitude ?? null,
    parkedLng: rvs.data?.lastParkedLocation?.longitude ?? null,
    parkedAt: rvs.data?.lastParkedLocation?.timestamp ?? null,
    capturedAt:
      charge.data?.carCapturedTimestamp ??
      bat?.carCapturedTimestamp ??
      rvs.data?.timestamp ??
      null,
    rvsUpdatedAt: rvs.data?.timestamp ?? null,
    doorsUpdatedAt: closureTimestamp(ext?.doorStatus),
    locksUpdatedAt: closureTimestamp(ext?.doorLockStatus),
    windowsUpdatedAt: closureTimestamp(ext?.windowStatus),
    chargeUpdatedAt:
      charge.data?.carCapturedTimestamp ?? bat?.carCapturedTimestamp ?? null,
  };
}

// ---- remote commands (S-PIN gated) -----------------------------------------
// Verified live against the ID Buzz; see CLAUDE.md "VW protocol". The S-PIN
// gates a per-vehicle session token, which the lock/unlock call carries.

interface ChallengeResponse {
  data?: { challenge?: string; remainingTries?: number };
}
interface SpinSessionResponse {
  data?: { carnetVehicleToken?: string };
}

/**
 * Mint a per-vehicle S-PIN token:
 *   GET  /ss/v1/user/{userId}/challenge  -> data.challenge, data.remainingTries
 *   spinHash = sha512(`${challenge}.${spin}`) lowercase hex
 *   POST /ss/v1/user/{userId}/vehicle/{uuid}/session {idToken, spinHash, tsp:"WCT"}
 *        (Bearer = access_token; id_token goes in the body) -> data.carnetVehicleToken
 */
async function vwSpinSession(
  accessToken: string,
  idToken: string,
  userId: string,
  uuid: string,
  spin: string,
): Promise<string> {
  const ch = await fetch(`${API}/ss/v1/user/${userId}/challenge`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": APP_UA,
    },
  });
  if (ch.status === 401) throw new VwAuthError("unauthorized");
  if (!ch.ok)
    throw new VwCommandError(`S-PIN challenge failed (${String(ch.status)})`);
  const chRaw: unknown = await ch.json();
  const chBody = chRaw as ChallengeResponse;
  const challenge = chBody.data?.challenge;
  const remaining = chBody.data?.remainingTries;
  if (challenge === undefined)
    throw new VwCommandError("VW returned no S-PIN challenge");
  // Lockout early warning: this should sit at VW's maximum — a downward trend
  // means something is burning attempts (a lockout needs a dealer/app reset).
  console.log(
    `[vw] S-PIN challenge remainingTries=${remaining === undefined ? "?" : String(remaining)}`,
  );
  // Stop well before VW locks the S-PIN; a lockout needs a dealer/app reset.
  if (typeof remaining === "number" && remaining < 3)
    throw new VwCommandError(
      `Only ${String(remaining)} S-PIN attempts remain — refusing to risk a lockout. Check your PIN in the myVW app.`,
    );

  const spinHash = await sha512Hex(`${challenge}.${spin}`);
  const sp = await fetch(
    `${API}/ss/v1/user/${userId}/vehicle/${uuid}/session`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": APP_UA,
      },
      body: JSON.stringify({ idToken, spinHash, tsp: "WCT" }),
    },
  );
  if (sp.status === 401) throw new VwAuthError("unauthorized");
  if (sp.status === 403) throw new VwCommandError("Incorrect S-PIN.");
  if (!sp.ok)
    throw new VwCommandError(`S-PIN session failed (${String(sp.status)})`);
  const spRaw: unknown = await sp.json();
  const token = (spRaw as SpinSessionResponse).data?.carnetVehicleToken;
  if (token === undefined)
    throw new VwCommandError("VW returned no S-PIN session token");
  return token;
}

/**
 * Lock or unlock the doors. Returns the command's `correlationId` (used to poll
 * the operation result — VW's `result: 0` only means "accepted/queued", not
 * done; see vwAwaitCommandResult). Throws VwAuthError on token expiry (caller
 * should reauth + retry) or VwCommandError on a command-level rejection.
 */
export async function vwLockUnlock(
  carnetToken: string,
  uuid: string,
  action: "lock" | "unlock",
): Promise<string> {
  // Verified against the myVW APK (jadx → defpackage/mbg.java, commands/models/
  // LockAndUnlock.java): the S-PIN carnetVehicleToken IS the Authorization
  // bearer (not the access token, and there is no X-* spin header), and the
  // body is { lock: boolean } — NOT { action }. VW silently ignores an unknown
  // `action` field, which is why our old `action` unlock never actuated.
  const res = await fetch(`${API}/lockunlock/v1/vehicle/${uuid}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${carnetToken}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": APP_UA,
    },
    body: JSON.stringify({ lock: action === "lock" }),
  });
  if (res.status === 401) throw new VwAuthError("unauthorized");
  if (!res.ok)
    throw new VwCommandError(`${action} failed (${String(res.status)})`);
  const body = (await res.json().catch(() => null)) as {
    data?: { result?: number; correlationId?: string };
  } | null;
  // result === 0 means accepted; anything else is a refusal.
  if (body?.data?.result !== undefined && body.data.result !== 0)
    throw new VwCommandError(
      `${action} rejected by VW (result ${String(body.data.result)})`,
    );
  const correlationId = body?.data?.correlationId;
  if (correlationId === undefined)
    throw new VwCommandError(`${action}: VW returned no correlationId`);
  return correlationId;
}

interface HistoryResponse {
  data?: { responseBody?: string };
  responseBody?: string;
}

/**
 * `eventStatus.responseOutcome` values, from the myVW APK's `ttc` enum
 * (`defpackage/ttc.java`; the app's own EventStatus model has ONLY
 * `responseOutcome` + `responseCode` — it doesn't model `responseStatus` at all,
 * and the app treats Accepted/Success as non-errors).
 */
const OUTCOME_REJECTED = 0;
const OUTCOME_SUCCESS = 2;
const OUTCOME_FAILED = 3;

interface ParsedEvent {
  eventStatus?: {
    responseOutcome?: number;
    responseCode?: string;
    /** Undocumented and NOT modeled by the app; VW sends the STRING "1" here
     *  for EV ops, which is why a `=== 1` test silently failed. Unused. */
    responseStatus?: unknown;
  };
  /** JSON string with the op's own result detail (e.g. `cause`, `status`). */
  payloadString?: string;
}

/** A human-usable reason for a failed op: VW's responseCode when present (EV
 *  ops don't send one), else the payload's own cause/status fields. */
function commandFailureReason(parsed: ParsedEvent): string {
  const code = parsed.eventStatus?.responseCode;
  if (code !== undefined && code !== "") return code;
  try {
    const payload = JSON.parse(parsed.payloadString ?? "{}") as {
      data?: { cause?: string; status?: string; trigger?: string };
    };
    const d = payload.data ?? {};
    return [d.cause, d.status, d.trigger].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

/**
 * Wait for a remote command to actually finish, the way the myVW app does (it
 * keeps spinning until this confirms). Polls the operation history
 *   GET /history/v1/vehicle/{uuid}/correlationId/{correlationId}/ro/
 * (**carnet-gated since 2026-07-30** — with the access token it 403s, which the
 * loop below swallows as a transient read error, so every command would poll out
 * and report "unconfirmed") whose `responseBody` is a JSON string. While the
 * operation is queued it carries only request metadata; once the car executes it
 * gains an `eventStatus`. Terminality comes from **`responseOutcome`** (the
 * app's own signal — see the ttc enum above): Success(2) confirms, Rejected(0)
 * and Failed(3) throw, and Accepted(1) means "queued, not finished yet" so we
 * keep polling. `responseCode` is also honoured for door ops, which report
 * "…RO_DOOR_SUCCESS" — EV/climate ops send no code at all.
 *
 * NOTE: do NOT test `responseStatus === 1`. VW sends it as the STRING "1" for EV
 * ops, so a strict-equality check fails and every successful climate stop was
 * reported as "Vehicle did not complete the command". (Latent until the carnet
 * fix, because this read used to 403 and never got parsed.)
 *
 * Resolves `{confirmed:true}` on success, throws VwCommandError on an explicit
 * failure, and resolves `{confirmed:false}` if no terminal status arrives within
 * the window (caller falls back to optimistic).
 */
export async function vwAwaitCommandResult(
  carnetToken: string,
  uuid: string,
  correlationId: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<{ confirmed: boolean }> {
  const attempts = opts.attempts ?? 8;
  const intervalMs = opts.intervalMs ?? 2500;
  const path = `/history/v1/vehicle/${uuid}/correlationId/${correlationId}/ro/`;
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    let raw: string | undefined;
    try {
      const res = await apiGet<HistoryResponse>(carnetToken, path);
      raw = res.data?.responseBody ?? res.responseBody;
    } catch (err) {
      if (err instanceof VwAuthError) throw err;
      continue; // transient read error — keep polling
    }
    if (typeof raw !== "string") continue;
    let parsed: ParsedEvent;
    try {
      parsed = JSON.parse(raw) as ParsedEvent;
    } catch {
      continue;
    }
    const ev = parsed.eventStatus;
    if (ev === undefined) continue; // still queued/in-progress
    const code = ev.responseCode ?? "";
    if (ev.responseOutcome === OUTCOME_SUCCESS || /success/i.test(code))
      return { confirmed: true };
    if (
      ev.responseOutcome === OUTCOME_REJECTED ||
      ev.responseOutcome === OUTCOME_FAILED ||
      // No outcome but a non-success code: the pre-2026-07 door-op shape, where
      // a code like "…RO_DOOR_FAILED" IS the terminal verdict. Without this a
      // failed lock/unlock would poll out and be reported as optimistic success.
      (ev.responseOutcome === undefined && code !== "")
    ) {
      // Terminal failure — surface the vehicle's reason (e.g. "ignition is on").
      const reason = commandFailureReason(parsed);
      throw new VwCommandError(
        `Vehicle did not complete the command${reason ? ` (${reason})` : ""}`,
      );
    }
    // Accepted(1) or an outcome we don't recognise: not terminal — keep polling.
    continue;
  }
  return { confirmed: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wake the car and make it report fresh telemetry to VW (what the myVW app's
 * pull-to-refresh does). Like lock/unlock it's S-PIN gated — the
 * carnetVehicleToken is the Authorization bearer (verified against the APK:
 * iface defpackage/gig.java `@eta` POST, interceptor defpackage/xfg.java; with
 * the plain access token as bearer this returns 403 USER_NOT_AUTHORIZED).
 *
 * Asynchronous: a 200 (`result: 0`) only means VW accepted the request — the
 * car reports in ~10–60s, after which the cron's next poll stores the fresh
 * snapshot. Throws VwAuthError on token expiry (caller reauths + retries) or
 * VwCommandError on a command-level rejection (incl. throttling).
 */
export async function vwForceRefresh(
  carnetToken: string,
  uuid: string,
): Promise<void> {
  const res = await fetch(`${API}/rvs/v1/vehicle/${uuid}/refresh`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${carnetToken}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": APP_UA,
    },
  });
  if (res.status === 401) throw new VwAuthError("unauthorized");
  if (!res.ok)
    throw new VwCommandError(`force-refresh failed (${String(res.status)})`);
  const body = (await res.json().catch(() => null)) as {
    data?: { result?: number };
  } | null;
  if (body?.data?.result !== undefined && body.data.result !== 0)
    throw new VwCommandError(
      `force-refresh rejected by VW (result ${String(body.data.result)})`,
    );
}

// ---- climate (pre-trip climatization) --------------------------------------
// EV climate is S-PIN-gated exactly like lock/unlock: the carnetVehicleToken is
// the Authorization bearer (the access token 403s, even for the state read).
// All ops are async (200 {result,correlationId}; confirm via vwAwaitCommandResult)
// and EV-rate-limited — VW returns EV_THRESHOLD_EXCEEDED while a prior op is in
// flight, surfaced here as VwBusyError so callers space/retry. Verified live;
// re-issuing start while ON does NOT extend the car's ~30-min auto-off.

/** Mint a reusable per-vehicle S-PIN session token (carnetVehicleToken). */
export async function vwMintSpinSession(
  tokens: { accessToken: string; idToken: string | null },
  uuid: string,
  spin: string,
): Promise<string> {
  if (tokens.idToken === null) throw new VwAuthError("missing id_token");
  return vwSpinSession(
    tokens.accessToken,
    tokens.idToken,
    userIdFromIdToken(tokens.idToken),
    uuid,
    spin,
  );
}

export interface ClimateState {
  on: boolean;
  remainingMin: number | null;
  targetTempF: number | null;
}

/** Read climate state from the EV summary (carnet bearer; access token 403s). */
export async function vwGetClimate(
  carnetToken: string,
  tokens: { idToken: string | null },
  uuid: string,
): Promise<ClimateState> {
  if (tokens.idToken === null) throw new VwAuthError("missing id_token");
  const userId = userIdFromIdToken(tokens.idToken);
  const res = await fetch(
    `${API}/ev/v1/user/${userId}/vehicle/${uuid}/summary?tempUnit=fahrenheit`,
    {
      headers: {
        authorization: `Bearer ${carnetToken}`,
        accept: "application/json",
        "user-agent": APP_UA,
      },
    },
  );
  if (res.status === 401) throw new VwAuthError("unauthorized");
  if (!res.ok)
    throw new VwCommandError(
      `climate state read failed (${String(res.status)})`,
    );
  const body = (await res.json().catch(() => null)) as {
    data?: { climateStatus?: ClimateSummary };
    climateStatus?: ClimateSummary;
  } | null;
  const climate = body?.data?.climateStatus ?? body?.climateStatus;
  const report = climate?.climateStatusReport;
  const ind = report?.climateStatusInd;
  return {
    on: ind !== undefined && ind !== null && ind !== "off",
    remainingMin: report?.remainingClimatizationTimeMin ?? null,
    targetTempF:
      climate?.climateSettings?.targetTemperature?.temperature ?? null,
  };
}
interface ClimateSummary {
  climateStatusReport?: {
    climateStatusInd?: string | null;
    remainingClimatizationTimeMin?: number | null;
  };
  climateSettings?: { targetTemperature?: { temperature?: number | null } };
}

/** POST an EV command (carnet bearer). Returns correlationId. Maps the EV
 *  rate-limit to VwBusyError and 401 to VwAuthError. */
async function evCommand(
  carnetToken: string,
  method: string,
  path: string,
  jsonBody?: unknown,
): Promise<string> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${carnetToken}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": APP_UA,
    },
    body: jsonBody === undefined ? null : JSON.stringify(jsonBody),
  });
  if (res.status === 401) throw new VwAuthError("unauthorized");
  const body = (await res.json().catch(() => null)) as {
    data?: { result?: number; correlationId?: string };
    error?: { errorCode?: string; errorDescription?: string };
  } | null;
  if (!res.ok) {
    if (body?.error?.errorCode === "EV_THRESHOLD_EXCEEDED")
      throw new VwBusyError(
        body.error.errorDescription ??
          "Vehicle is busy with a previous request.",
      );
    throw new VwCommandError(`EV command failed (${String(res.status)})`);
  }
  if (body?.data?.result !== undefined && body.data.result !== 0)
    throw new VwCommandError(
      `EV command rejected by VW (result ${String(body.data.result)})`,
    );
  const correlationId = body?.data?.correlationId;
  if (correlationId === undefined)
    throw new VwCommandError("EV command: VW returned no correlationId");
  return correlationId;
}

/** Read the current cabin target temperature (°F). S-PIN (carnet) gated since
 *  2026-07-30 — this settings GET used to accept the plain access token and now
 *  403s with it, like every other /ev read. */
export async function vwGetClimateTargetTempF(
  carnetToken: string,
  uuid: string,
): Promise<number | null> {
  const data = await apiGet<{
    data?: { targetTemperature?: { temperature?: number | null } };
  }>(
    carnetToken,
    `/ev/v1/vehicle/${uuid}/pretripclimate/settings?tempUnit=fahrenheit`,
  );
  return data.data?.targetTemperature?.temperature ?? null;
}

export const vwClimateStart = (carnet: string, uuid: string): Promise<string> =>
  evCommand(carnet, "POST", `/ev/v1/vehicle/${uuid}/pretripclimate/start`);

export const vwClimateStop = (carnet: string, uuid: string): Promise<string> =>
  evCommand(carnet, "POST", `/ev/v1/vehicle/${uuid}/pretripclimate/stop`);

/**
 * Set the cabin target temperature (°F). Reads current settings (to preserve
 * the element settings), then PUTs the new temp. Async — confirm via the
 * returned correlationId. Climate must be OFF for this to take effect.
 */
export async function vwSetClimateTemp(
  carnet: string,
  uuid: string,
  tempF: number,
): Promise<string> {
  const path = `/ev/v1/vehicle/${uuid}/pretripclimate/settings?tempUnit=fahrenheit`;
  const cur = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${carnet}`,
      accept: "application/json",
      "user-agent": APP_UA,
    },
  });
  const curData = (
    (await cur.json().catch(() => null)) as {
      data?: ClimateSettingsData;
    } | null
  )?.data;
  const elements = curData?.climatizationElementSettings ?? {
    climatizationAtUnlock: true,
    mirrorHeatingEnabled: false,
    zoneFrontLeftEnabled: false,
    zoneFrontRightEnabled: false,
    zoneRearLeftEnabled: false,
    zoneRearRightEnabled: false,
  };
  return evCommand(carnet, "PUT", path, {
    targetTemperature: { temperature: tempF, unit: "fahrenheit" },
    climatizationWithoutExternalPower:
      curData?.climatizationWithoutExternalPower ?? true,
    climatizationElementSettings: elements,
  });
}
interface ClimateSettingsData {
  climatizationWithoutExternalPower?: boolean;
  climatizationElementSettings?: Record<string, boolean>;
  targetTemperature?: { temperature?: number | null };
}

// ---- charging commands (carnet bearer, EV-rate-limited like climate) --------
// Verified live against the APK (iface po5.java): start/stop is
// POST /charging/{start|stop} with body {actionMode:"immediate"}; the limit is
// PUT /charging/settings carrying the full ChargingSettings with a new
// targetSOCPercentage.

/** Stop charging now. Async (confirm via correlationId); EV-rate-limited. */
export const vwChargeStop = (carnet: string, uuid: string): Promise<string> =>
  evCommand(carnet, "POST", `/ev/v1/vehicle/${uuid}/charging/stop`, {
    actionMode: "immediate",
  });

/** Start charging now. */
export const vwChargeStart = (carnet: string, uuid: string): Promise<string> =>
  evCommand(carnet, "POST", `/ev/v1/vehicle/${uuid}/charging/start`, {
    actionMode: "immediate",
  });

interface ChargingSettingsData {
  autoUnlockPlugWhenCharged?: string;
  maxChargingCurrent?: string;
  targetSOCPercentage?: number;
  targetRangeKm?: number;
  chargeModeSelection?: string;
}

/**
 * Set the charge limit (target SoC %). Reads current charging settings and
 * PUTs them back with the new target, preserving the rest (VW replaces the
 * whole ChargingSettings object). Async — confirm via the correlationId.
 */
export async function vwSetChargeLimit(
  carnet: string,
  uuid: string,
  targetSoc: number,
): Promise<string> {
  const path = `/ev/v1/vehicle/${uuid}/charging/settings`;
  const cur = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${carnet}`,
      accept: "application/json",
      "user-agent": APP_UA,
    },
  });
  const settings =
    (
      (await cur.json().catch(() => null)) as {
        data?: { chargingSettings?: ChargingSettingsData };
      } | null
    )?.data?.chargingSettings ?? {};
  return evCommand(carnet, "PUT", path, {
    ...settings,
    targetSOCPercentage: targetSoc,
  });
}

// ---- activity history (carnet bearer; Tier-2 read) --------------------------

export interface ActivityEvent {
  at: number | null;
  title: string;
  description: string | null;
  type: string | null;
}
interface ActivityRow {
  eventTimestamp?: number;
  title?: string;
  description?: string;
  activityType?: string;
}

/**
 * The car's recent activity log (commands, trips, alerts). Carnet-gated;
 * pageNum is 0-indexed like the message center's (VERIFIED LIVE 2026-07-21:
 * pageNum=1 skips past the newest pageSize events — an empty list when the
 * whole history fits on one page).
 */
export async function vwGetActivity(
  carnetToken: string,
  uuid: string,
  pageSize: number,
): Promise<ActivityEvent[]> {
  const res = await fetch(
    `${API}/history/activity/v1/vehicle/${uuid}?pageNum=0&pageSize=${String(pageSize)}`,
    {
      headers: {
        authorization: `Bearer ${carnetToken}`,
        accept: "application/json",
        "user-agent": APP_UA,
      },
    },
  );
  if (res.status === 401) throw new VwAuthError("unauthorized");
  if (!res.ok)
    throw new VwCommandError(`activity read failed (${String(res.status)})`);
  const body = (await res.json().catch(() => null)) as {
    data?: { activityHistory?: ActivityRow[] };
  } | null;
  return (body?.data?.activityHistory ?? []).map((r) => ({
    at: r.eventTimestamp ?? null,
    title: r.title ?? "Activity",
    description: r.description ?? null,
    type: r.activityType ?? null,
  }));
}

// ---- message center inbox (carnet bearer; Tier-2 read) ----------------------

export interface InboxMessage {
  id: string;
  title: string;
  body: string | null;
  read: boolean;
  at: number | null;
}
interface MessageRow {
  notificationId?: string;
  trackingId?: string;
  title?: string;
  heading?: string;
  description?: string;
  read?: boolean;
  triggerDateInEpochMs?: number;
}

/** The myVW message-center inbox. Carnet-gated; pageNum is 0-indexed here. */
export async function vwGetMessages(
  carnetToken: string,
  tokens: { idToken: string | null },
  uuid: string,
  pageSize: number,
): Promise<InboxMessage[]> {
  if (tokens.idToken === null) throw new VwAuthError("missing id_token");
  const userId = userIdFromIdToken(tokens.idToken);
  const res = await fetch(
    `${API}/messagecenter/v2/user/${userId}/vehicle/${uuid}?type=messages&pageNum=0&pageSize=${String(pageSize)}`,
    {
      headers: {
        authorization: `Bearer ${carnetToken}`,
        accept: "application/json",
        "user-agent": APP_UA,
      },
    },
  );
  if (res.status === 401) throw new VwAuthError("unauthorized");
  if (!res.ok)
    throw new VwCommandError(`messages read failed (${String(res.status)})`);
  const body = (await res.json().catch(() => null)) as {
    data?: { notifications?: MessageRow[] };
  } | null;
  return (body?.data?.notifications ?? []).map((m) => ({
    id: m.notificationId ?? m.trackingId ?? "",
    title: m.title ?? m.heading ?? "Message",
    body: m.description ?? null,
    read: m.read === true,
    at: m.triggerDateInEpochMs ?? null,
  }));
}
