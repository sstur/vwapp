/** End-to-end RPC + database checks; --renew exercises concurrent token expiry. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "@vwapp/contract";
import { sha256Hex } from "../src/crypto";
import type { AppEnv } from "../src/env";
import { getAccountByUserKey, getDb } from "../src/store";

const env = process.env as unknown as AppEnv;
const username = process.env.VW_USERNAME,
  password = process.env.VW_PASSWORD,
  spin = process.env.VW_PIN;
if (!username || !password || !spin) throw new Error("Missing credentials");
const db = getDb(env);
const token = await db.auth.createToken({
  email: "api-restoration@vwapp.invalid",
});
const client: ContractRouterClient<typeof contract> = createORPCClient(
  new RPCLink({
    url: process.env.API_URL ?? "http://localhost:8787/rpc",
    headers: { authorization: `Bearer ${token}` },
  }),
);
const report: Record<string, unknown> = { at: Date.now() };
try {
  assert.equal(
    (await client.auth.checkCredentials({ username, password })).ok,
    true,
  );
  assert.equal(
    (await client.auth.login({ username, password, spin })).ok,
    true,
  );
  assert.equal((await client.auth.me()).loggedIn, true);
  console.log("Credentials / login / session: OK");
  if (process.argv.includes("--renew")) {
    const account = await getAccountByUserKey(
      db,
      await sha256Hex(username.trim().toLowerCase()),
    );
    if (!account) throw new Error("Missing account");
    const tx = db.tx.vwAccounts[account.id];
    if (!tx) throw new Error("Missing transaction builder");
    await db.transact(tx.update({ tokenExpiresAt: 0, carnetTokens: "{}" }));
    const [activity, messages] = await Promise.all([
      client.vehicle.activity({}),
      client.vehicle.messages({}),
    ]);
    report.concurrentRenewal = {
      activities: activity.events.length,
      messages: messages.messages.length,
    };
    console.log("Concurrent expired-token requests: OK");
  }
  const [status, climate, activity, messages] = await Promise.all([
    client.vehicle.refresh({}),
    client.vehicle.climateInfo({}),
    client.vehicle.activity({}),
    client.vehicle.messages({}),
  ]);
  report.reads = {
    soc: status.soc,
    targetTempF: climate.targetTempF,
    activities: activity.events.length,
    messages: messages.messages.length,
    hasLocation: status.parkedLat !== null,
  };
  console.log("Status / climate / activity / inbox:", report.reads);
  await client.vehicle.refreshMessages({});
  console.log("Inbox database sync: OK");
  if (status.parkedLat !== null && status.parkedLng !== null) {
    const map = await client.vehicle.parkedMapUrl({
      lat: status.parkedLat,
      lng: status.parkedLng,
      widthPt: 300,
      heightPt: 200,
      dark: false,
    });
    if (!map.url) throw new Error("Map signing not configured");
    const response = await fetch(map.url);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith("image/"));
    console.log("Signed parked-location map: OK");
    report.map = true;
  }
  const rows = await db.query({
    vwAccounts: {
      vehicles: {
        snapshots: { $: { order: { createdAt: "desc" }, limit: 1 } },
      },
      messages: {},
    },
  });
  assert.ok(rows.vwAccounts[0]?.vehicles[0]?.snapshots.length);
  report.snapshotStored = true;
  console.log("Snapshot persisted for app subscription: OK");
} finally {
  await client.auth.logout();
  assert.equal((await client.auth.me()).loggedIn, false);
  writeFileSync(
    homedir() + "/.config/vw-integrity-bridge/rpc-verification.json",
    JSON.stringify(report),
    { mode: 0o600 },
  );
}
