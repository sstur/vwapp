import type { AppEnv } from "./env";

/** Infrastructure failures must never trigger a password-login fallback. */
export class IntegrityUnavailableError extends Error {
  constructor() {
    super(
      "The VW authentication bridge is unavailable. Please try again shortly.",
    );
  }
}

export type IntegrityProvider = (binding: string) => Promise<string>;

/** myVW uses padded base64url SHA-256 (PKCE itself uses unpadded base64url). */
export async function integrityRequestHash(binding: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(binding),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Only a request hash reaches the Mac; passwords, PINs and VW tokens stay here. */
export function integrityProvider(env: AppEnv): IntegrityProvider {
  return async (binding) => {
    if (!env.INTEGRITY_BRIDGE_URL || !env.INTEGRITY_BRIDGE_KEY) {
      console.error("[integrity] bridge configuration missing");
      throw new IntegrityUnavailableError();
    }
    try {
      const url = new URL("/v1/integrity", env.INTEGRITY_BRIDGE_URL);
      if (
        url.protocol !== "https:" &&
        !["localhost", "127.0.0.1"].includes(url.hostname)
      ) {
        throw new IntegrityUnavailableError();
      }
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.INTEGRITY_BRIDGE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestHash: await integrityRequestHash(binding),
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(85_000),
      });
      if (!response.ok) {
        console.error(`[integrity] bridge HTTP ${String(response.status)}`);
        throw new IntegrityUnavailableError();
      }
      const body = await response.json<{ token?: unknown }>();
      if (
        typeof body.token !== "string" ||
        body.token.length < 100 ||
        body.token.length > 20000
      ) {
        throw new IntegrityUnavailableError();
      }
      return body.token;
    } catch (error) {
      console.error(
        "[integrity] failure type",
        error instanceof Error ? error.name : "unknown",
      );
      throw new IntegrityUnavailableError();
    }
  };
}
