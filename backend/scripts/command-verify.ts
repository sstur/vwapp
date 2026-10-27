/** Explicit live test: briefly run climate at its existing setpoint, then stop. */
import assert from "node:assert/strict";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract } from "@vwapp/contract";
import { sha256Hex } from "../src/crypto";
import type { AppEnv } from "../src/env";
import {
  getAccountByUserKey,
  getDb,
  listActiveClimateSessions,
} from "../src/store";
import { vwGetClimate } from "../src/vw/client";

const env = process.env as unknown as AppEnv;
const username = process.env.VW_USERNAME,
  password = process.env.VW_PASSWORD,
  spin = process.env.VW_PIN;
if (!username || !password || !spin) throw new Error("Missing credentials");
const db = getDb(env);
const userKey = await sha256Hex(username.trim().toLowerCase());
const token = await db.auth.createToken({
  email: "api-restoration@vwapp.invalid",
});
const client: ContractRouterClient<typeof contract> = createORPCClient(
  new RPCLink({
    url: process.env.API_URL ?? "http://localhost:8787/rpc",
    headers: { authorization: `Bearer ${token}` },
  }),
);
async function climate() {
  const account = await getAccountByUserKey(db, userKey);
  if (!account) throw new Error("Missing account");
  const entry = Object.entries(account.carnetTokens)[0];
  if (!entry) throw new Error("Missing S-PIN session");
  return vwGetClimate(entry[1].token, account.tokens, entry[0]);
}
let started = false;
try {
  await client.auth.login({ username, password, spin });
  assert.equal(
    (await listActiveClimateSessions(db)).length,
    0,
    "An existing climate session must not be interrupted",
  );
  const before = await climate();
  assert.equal(before.on, false, "Climate must already be off");
  assert.ok(before.targetTempF !== null);
  console.log("Baseline: climate off, target", before.targetTempF);
  started = true;
  await client.vehicle.climateStart({
    tempF: before.targetTempF,
    durationMin: 15,
  });
  console.log("Climate start RPC accepted; checking reported state");
  let on = false;
  for (let i = 0; i < 10; i++) {
    if ((await climate()).on) {
      on = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("Climate reported on:", on);
  assert.equal(on, true, "Car did not report climate running");
} finally {
  if (started) {
    await client.vehicle.climateStop({});
    console.log("Climate stop RPC accepted");
    let off = false;
    for (let i = 0; i < 10; i++) {
      if (!(await climate()).on) {
        off = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    assert.equal(off, true, "Car did not report climate stopped");
    assert.equal((await listActiveClimateSessions(db)).length, 0);
    console.log("Climate off and managed session ended: OK");
  }
  await client.auth.logout();
}
