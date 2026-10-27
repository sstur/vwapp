/** Live API verification. No physical vehicle commands. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { seal, sha256Hex } from "../src/crypto";
import type { AppEnv } from "../src/env";
import { integrityProvider } from "../src/integrity";
import {
  clearLoginFailures,
  getAccountByUserKey,
  getDb,
  saveAccountSession,
  saveCarnetToken,
  saveSnapshot,
} from "../src/store";
import {
  jwtExpiryMs,
  vwGetActivity,
  vwGetClimate,
  vwGetClimateTargetTempF,
  vwGetMessages,
  vwGetStatus,
  vwGetVehicles,
  vwLogin,
  vwMintSpinSession,
  vwRefresh,
  type VwTokens,
} from "../src/vw/client";

const env = process.env as unknown as AppEnv;
const username = process.env.VW_USERNAME;
const password = process.env.VW_PASSWORD;
const spin = process.env.VW_PIN;
if (!username || !password || !spin) throw new Error("Missing VW credentials");
const dir = join(homedir(), ".config/vw-integrity-bridge");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const sessionPath = join(dir, "api-session.json");
const mode = process.argv[2] ?? "verify";
const integrity = integrityProvider(env);
let tokens: VwTokens;
if (mode === "login") {
  tokens = await vwLogin(username, password, integrity);
  console.log("Fresh password login + phone integrity: OK");
} else {
  tokens = JSON.parse(readFileSync(sessionPath, "utf8")) as VwTokens;
  if (mode === "refresh" || tokens.expiresAt < Date.now() + 60_000) {
    if (!tokens.refreshToken) throw new Error("No refresh token");
    tokens = await vwRefresh(
      tokens.refreshToken,
      tokens.codeVerifier,
      integrity,
    );
    console.log("API token refresh + phone integrity: OK");
  }
}
writeFileSync(sessionPath, JSON.stringify(tokens), { mode: 0o600 });
const vehicles = await vwGetVehicles(tokens.accessToken);
console.log("Garage:", vehicles.length, "vehicle(s)");
const vehicle = vehicles[0];
if (!vehicle) throw new Error("No vehicle");
const carnet = await vwMintSpinSession(tokens, vehicle.uuid, spin);
console.log("S-PIN session: OK");
const status = await vwGetStatus(carnet, vehicle.vin, vehicle.uuid);
console.log("Status:", {
  soc: status.soc,
  chargeState: status.chargeState,
  hasLocation: status.parkedLat !== null,
  openDoors: status.openDoors.length,
  openWindows: status.openWindows.length,
});
const results = await Promise.allSettled([
  vwGetClimate(carnet, tokens, vehicle.uuid),
  vwGetClimateTargetTempF(carnet, vehicle.uuid),
  vwGetActivity(carnet, vehicle.uuid, 100),
  vwGetMessages(carnet, tokens, vehicle.uuid, 100),
]);
for (const [i, result] of results.entries()) {
  console.log(
    ["climate", "temperature", "activity", "messages"][i],
    result.status === "fulfilled"
      ? Array.isArray(result.value)
        ? `${String(result.value.length)} items`
        : "OK"
      : String(result.reason),
  );
}
writeFileSync(
  join(dir, "api-verification.json"),
  JSON.stringify({ at: Date.now(), status, results }),
  { mode: 0o600 },
);
if (results.some((r) => r.status === "rejected"))
  throw new Error("One or more API reads failed");
if (mode === "seed") {
  const db = getDb(env);
  const userKey = await sha256Hex(username.trim().toLowerCase());
  const storedVehicles = await saveAccountSession(
    db,
    userKey,
    await seal(env.CREDS_ENC_KEY, JSON.stringify({ username, password, spin })),
    tokens,
    vehicles,
  );
  const account = await getAccountByUserKey(db, userKey);
  if (!account) throw new Error("Account was not saved");
  await clearLoginFailures(db, account);
  await saveCarnetToken(db, account, vehicle.uuid, {
    token: carnet,
    expiresAt: jwtExpiryMs(carnet) ?? Date.now() + 25 * 60_000,
  });
  const storedVehicle = storedVehicles.find((v) => v.uuid === vehicle.uuid);
  if (storedVehicle) await saveSnapshot(db, storedVehicle.id, status);
  console.log(
    "Shared account session restored; existing client links preserved",
  );
}
