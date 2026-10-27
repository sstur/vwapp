/**
 * Reading live vehicle status from VW.
 *
 * Since 2026-07-30 the `/rvs` and `/ev` reads are S-PIN gated (they 403 with a
 * plain access token — see vw/client.ts `vwGetStatus`), so every status read
 * now needs a per-vehicle carnet token. That token is cached on the account and
 * only re-minted near expiry (`ensureCarnetToken`), which is what keeps the
 * every-minute cron from hammering the S-PIN challenge endpoint.
 */
import type { StatusDTO } from "@vwapp/contract";
import type { AppEnv } from "./env";
import type { Db, StoredAccount, StoredVehicle } from "./store";
import { ensureCarnetToken } from "./tokens";
import { VwAuthError, vwGetStatus } from "./vw/client";

/**
 * Live status for one vehicle, through the cached carnet token. A 401 means the
 * cached token expired mid-flight (or the access token behind it did), so
 * re-mint once and retry — anything else propagates.
 */
export async function readStatus(
  db: Db,
  env: AppEnv,
  account: StoredAccount,
  vehicle: StoredVehicle,
  spin: string,
): Promise<StatusDTO> {
  const carnet = await ensureCarnetToken(db, env, account, vehicle.uuid, spin);
  try {
    return await vwGetStatus(carnet, vehicle.vin, vehicle.uuid);
  } catch (err) {
    if (!(err instanceof VwAuthError)) throw err;
    const fresh = await ensureCarnetToken(
      db,
      env,
      account,
      vehicle.uuid,
      spin,
      { force: true },
    );
    return vwGetStatus(fresh, vehicle.vin, vehicle.uuid);
  }
}
