/** Apple Maps Web Snapshot URL signing (token-based auth, Web Crypto only). */
import type { AppEnv } from "./env";

const SNAPSHOT_URL = "https://snapshot.apple-mapkit.com/api/v1/snapshot";
/** MapKit token lifetime; the app refetches the URL before this elapses. */
const TOKEN_TTL_SEC = 30 * 60;

const encoder = new TextEncoder();

/** Copy into a fresh ArrayBuffer-backed view (Web Crypto rejects SharedArrayBuffer). */
function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u.length);
  copy.set(u);
  return copy.buffer;
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlText(text: string): string {
  return base64Url(encoder.encode(text));
}

/** Import a PKCS#8 PEM (.p8) EC P-256 private key for ES256 signing. */
async function importSigningKey(pem: string): Promise<CryptoKey> {
  const der = pem
    .replace(/\\n/g, "\n") // tolerate \n-escaped PEMs from env storage
    .replace(/-----[^-]+-----/g, "") // strip BEGIN/END lines
    .replace(/\s+/g, ""); // strip all real whitespace, leaving base64
  const bytes = Uint8Array.from(atob(der), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(bytes),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * Mint a MapKit JS token (JWT, ES256): header carries the key id (`kid`),
 * payload the team id (`iss`) plus issued/expiry times. No `origin` claim —
 * this is signed server-side, not bound to a web origin. WebCrypto's ECDSA
 * output is already the raw r‖s form ES256 expects.
 */
async function mintToken(env: AppEnv): Promise<string> {
  const header = { alg: "ES256", kid: env.APPLE_MAPS_KEY_ID, typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    iss: env.APPLE_MAPS_TEAM_ID,
    iat,
    exp: iat + TOKEN_TTL_SEC,
  };
  const signingInput = `${base64UrlText(JSON.stringify(header))}.${base64UrlText(JSON.stringify(payload))}`;
  const key = await importSigningKey(env.APPLE_MAPS_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(encoder.encode(signingInput)),
  );
  return `${signingInput}.${base64Url(new Uint8Array(sig))}`;
}

export interface SnapshotOptions {
  lat: number;
  lng: number;
  widthPt: number;
  heightPt: number;
  /** Retina factor (1–3); 2 is a good default for iPhone. */
  scale: number;
  dark: boolean;
}

/**
 * Build a signed Apple Maps Web Snapshot URL for a single pinned coordinate.
 *
 * Token-based auth: a short-lived MapKit JWT (signed with the server-held .p8;
 * the key never leaves the Worker) is appended as `&token=`. The resulting URL
 * is safe to hand to the client — it embeds only a time-boxed token scoped to
 * Maps, and the app loads it as a plain image.
 */
export async function signSnapshotUrl(
  env: AppEnv,
  opts: SnapshotOptions,
): Promise<string> {
  const center = `${String(opts.lat)},${String(opts.lng)}`;
  const annotations = JSON.stringify([
    { point: center, color: "1a73e8", markerStyle: "balloon" },
  ]);

  const params = new URLSearchParams();
  params.set("center", center);
  params.set("z", "16");
  params.set("size", `${String(opts.widthPt)}x${String(opts.heightPt)}`);
  params.set("scale", String(opts.scale));
  params.set("t", "standard");
  params.set("colorScheme", opts.dark ? "dark" : "light");
  params.set("poi", "1");
  params.set("annotations", annotations);
  params.set("token", await mintToken(env));

  return `${SNAPSHOT_URL}?${params.toString()}`;
}
