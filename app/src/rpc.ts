import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { contract } from "@vwapp/contract";
import Constants from "expo-constants";
import { db } from "./db";

/**
 * EXPO_PUBLIC_API_URL points at the deployed Worker (e.g.
 * https://vwapp-api.<your-subdomain>.workers.dev/rpc) and is required for any
 * published build — set it per-deployer in app/.env. Otherwise, when served by
 * a Metro dev server, target the Worker dev server on the same machine (hostUri
 * is the Metro host — localhost for a simulator, the LAN IP for a physical
 * device). A published bundle (EAS Update) has no dev server, so it must rely on
 * EXPO_PUBLIC_API_URL; with neither present we fail loudly rather than guess.
 */
function resolveApiUrl(): string {
  const override = process.env.EXPO_PUBLIC_API_URL;
  if (override !== undefined && override !== "") return override;
  const hostUri = Constants.expoConfig?.hostUri;
  if (__DEV__ && hostUri !== undefined) {
    const host = hostUri.split(":")[0];
    if (host !== undefined && host !== "") return `http://${host}:8787/rpc`;
  }
  throw new Error(
    "Set EXPO_PUBLIC_API_URL in app/.env to your deployed Worker URL (e.g. https://vwapp-api.<subdomain>.workers.dev/rpc)",
  );
}

/** Exported for display in Settings — "which backend am I talking to?". */
export const API_URL = resolveApiUrl();

const link = new RPCLink({
  url: API_URL,
  // The Worker verifies this Instant guest token to identify the user.
  headers: async () => {
    const user = await db.getAuth();
    return user === null
      ? {}
      : { authorization: `Bearer ${user.refresh_token}` };
  },
});

export const client =
  createORPCClient<ContractRouterClient<typeof contract>>(link);
export const orpc = createTanstackQueryUtils(client);
