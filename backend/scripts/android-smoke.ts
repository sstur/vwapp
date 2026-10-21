/** Real end-to-end phone smoke. Logs no credentials, tokens, VINs, or raw UI. */
import { init } from "@instantdb/admin";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "@vwapp/contract";
import schema from "@vwapp/db";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
const db = init({
  appId: required("INSTANT_APP_ID"),
  adminToken: required("INSTANT_ADMIN_TOKEN"),
  schema,
});
const token = await db.auth.createToken({
  email: "android-smoke@vwapp.invalid",
});
const client: ContractRouterClient<typeof contract> = createORPCClient(
  new RPCLink({
    url: required("API_URL"),
    headers: { authorization: `Bearer ${token}` },
  }),
);
console.log("Signing in through the cloud provider");
await client.auth.login({
  username: required("VW_USERNAME"),
  password: required("VW_PASSWORD"),
  spin: required("VW_PIN"),
});
console.log("Cloud login succeeded");
try {
  const status = await client.vehicle.refresh({});
  if (
    status.source !== "android" ||
    status.capturedAt !== null ||
    status.closuresKnown !== false
  )
    throw new Error("Unexpected status source or freshness semantics");
  console.log("Status verified", {
    soc: status.soc,
    climateOn: status.climateOn,
    targetTempF: status.targetTempF,
    observedAt: status.observedAt,
  });
  if (process.argv.includes("--controls")) {
    if (status.climateOn !== false || status.targetTempF == null)
      throw new Error(
        "Climate must be off with a known setpoint for this supervised test",
      );
    const requestId = crypto.randomUUID();
    try {
      console.log("Starting climate", requestId);
      await client.vehicle.climateStart({
        requestId,
        tempF: status.targetTempF,
        durationMin: 5,
      });
      const start = Date.now();
      await client.vehicle.climateStart({
        requestId,
        tempF: status.targetTempF,
        durationMin: 5,
      });
      console.log(
        "Duplicate command returned saved result in",
        Date.now() - start,
        "ms",
      );
    } finally {
      console.log("Restoring climate off");
      await client.vehicle.climateStop({ requestId: crypto.randomUUID() });
    }
  }
  const user = await db.auth.verifyToken(token);
  const rows = await db.query({
    vehicles: {
      $: { where: { "account.users.id": user.id } },
      snapshots: { $: { order: { createdAt: "desc" }, limit: 1 } },
    },
  });
  if (!rows.vehicles.some((v) => v.snapshots[0]?.source === "android"))
    throw new Error("Android snapshot did not reach InstantDB");
  console.log(
    "InstantDB subscription data verified; existing app can read the snapshot",
  );
} finally {
  await client.auth.logout();
  console.log("Smoke client detached; shared vehicle session preserved");
}
