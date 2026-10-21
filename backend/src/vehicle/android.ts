/** Cloud-facing phone API: credentials stay server-side; callers use vehicle intents. */
import { ORPCError } from "@orpc/server";
import { statusSchema, type StatusDTO } from "@vwapp/contract";
import { z } from "zod";
import { seal, unseal, type Sealed } from "../crypto";
import type { AppEnv } from "../env";
import type { StoredAccount, StoredVehicle } from "../store";

export const credentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  spin: z.string().optional(),
  forceLogin: z.boolean().optional(),
});
export type Credentials = z.infer<typeof credentialsSchema>;
export type Operation =
  | "session"
  | "status"
  | "climate"
  | "climateInfo"
  | "lock"
  | "charge"
  | "chargeLimit";
export interface Completion {
  vehicleId: string;
  climate?:
    | { kind: "start"; tempF: number; expiresAt: number; durationMin: number }
    | { kind: "stop"; reason: "stopped" | "expired" };
}
export interface PhoneJob {
  requestId: string;
  accountId: string;
  operation: Operation;
  vin: string | null;
  params: Record<string, unknown>;
  sealed: Sealed;
  completion?: Completion;
  background?: boolean;
}
export const jobResultSchema = z.object({
  requestId: z.string(),
  state: z.enum(["running", "succeeded", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .optional(),
});
export type JobResult = z.infer<typeof jobResultSchema>;

export function usesAndroid(env: AppEnv): boolean {
  return env.VEHICLE_PROVIDER === "android";
}
export function unsupported(): never {
  throw new ORPCError("NOT_IMPLEMENTED", {
    message: "This feature is not available through the myVW phone app yet.",
  });
}
export function phoneError(
  code: string,
  message: string,
  requestId?: string,
): never {
  const type =
    code === "DEVICE_BUSY"
      ? "CONFLICT"
      : code === "AUTH_FAILED" || code === "PIN_REJECTED"
        ? "UNAUTHORIZED"
        : code === "UNSUPPORTED_OPERATION"
          ? "NOT_IMPLEMENTED"
          : "SERVICE_UNAVAILABLE";
  throw new ORPCError(type, {
    message: `${message} [${code}${requestId ? `; request ${requestId}` : ""}]`,
  });
}

export async function credentials(
  env: AppEnv,
  account: StoredAccount,
): Promise<Credentials> {
  return credentialsSchema.parse(
    JSON.parse(await unseal(env.CREDS_ENC_KEY, account.sealed)),
  );
}

/** Waits for a durable cloud job. Its alarm continues after this caller disconnects. */
export async function phoneCall(
  env: AppEnv,
  job: PhoneJob,
  { background = false }: { background?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (
    !env.ANDROID_BRIDGE_URL ||
    !env.ANDROID_BRIDGE_KEY ||
    !env.ANDROID_GATEWAY
  )
    phoneError("CONFIGURATION", "Android bridge is not configured");
  const stub = env.ANDROID_GATEWAY.getByName("phone");
  const deadline = Date.now() + 540_000;
  let submitted = false;
  while (Date.now() < deadline) {
    const response = submitted
      ? await stub.fetch(`https://gateway/jobs/${job.requestId}`)
      : await stub.fetch("https://gateway/jobs", {
          method: "POST",
          body: JSON.stringify({ ...job, background }),
        });
    if (response.status === 409) {
      phoneError(
        "DEVICE_BUSY",
        "Phone queue is full; no new command was accepted",
        job.requestId,
      );
    }
    if (response.status === 422)
      phoneError(
        "IDEMPOTENCY_CONFLICT",
        "This request ID was already used with different parameters",
        job.requestId,
      );
    if (!response.ok)
      phoneError(
        "GATEWAY_ERROR",
        "Phone coordinator is unavailable",
        job.requestId,
      );
    const result = jobResultSchema.parse(await response.json());
    submitted = true;
    if (result.state === "succeeded") return result.result ?? {};
    if (result.state === "failed")
      phoneError(
        result.error?.code ?? "INTERNAL_ERROR",
        result.error?.message ?? "Phone job failed",
        job.requestId,
      );
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!submitted)
    phoneError(
      "DEVICE_BUSY",
      "Phone is still busy; no new job was submitted",
      job.requestId,
    );
  phoneError(
    "OUTCOME_UNKNOWN",
    "The request is still being reconciled. Check vehicle status before issuing another command",
    job.requestId,
  );
}

export async function vehicleCall(
  env: AppEnv,
  account: StoredAccount,
  vehicle: StoredVehicle,
  operation: Operation,
  params: Record<string, unknown> = {},
  options: {
    requestId?: string | undefined;
    completion?: Completion;
    background?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  return phoneCall(
    env,
    {
      requestId: options.requestId ?? crypto.randomUUID(),
      accountId: account.id,
      operation,
      vin: vehicle.vin,
      params,
      sealed: account.sealed,
      completion: options.completion ?? { vehicleId: vehicle.id },
    },
    { background: options.background ?? false },
  );
}

export async function sessionCall(
  env: AppEnv,
  accountId: string,
  creds: Credentials,
) {
  return phoneCall(env, {
    requestId: crypto.randomUUID(),
    accountId,
    operation: "session",
    vin: null,
    params: {},
    sealed: await seal(env.CREDS_ENC_KEY, JSON.stringify(creds)),
  });
}

export const phoneStatusSchema = z.object({
  vin: z.string(),
  soc: z.number().min(0).max(100).nullable(),
  rangeKm: z.number().nullable(),
  chargeState: z.string().nullable(),
  targetSoc: z.number().nullable(),
  locked: z.boolean().nullable(),
  minutesToTarget: z.number().nullable(),
  observedAt: z.string(),
  reportedUpdatedText: z.string().nullable(),
  climateOn: z.boolean(),
  targetTempF: z.number().nullable(),
  pluggedIn: z.boolean().nullable().optional(),
});
export function toStatus(raw: unknown): StatusDTO {
  const s = phoneStatusSchema.parse(raw);
  return statusSchema.parse({
    vin: s.vin,
    soc: s.soc,
    rangeKm: s.rangeKm,
    locked: s.locked,
    targetSoc: s.targetSoc,
    chargeState:
      s.chargeState === "Charging"
        ? "chargingHVBattery"
        : s.chargeState === "Charging complete"
          ? "complete"
          : s.chargeState,
    chargePowerKw: null,
    minutesToFull: s.targetSoc === 100 ? s.minutesToTarget : null,
    pluggedIn: s.pluggedIn ?? (s.chargeState === "Charging" ? true : null),
    plugLocked: null,
    openDoors: [],
    openWindows: [],
    unlockedDoors: [],
    odometerKm: null,
    parkedLat: null,
    parkedLng: null,
    parkedAt: null,
    capturedAt: null,
    rvsUpdatedAt: null,
    doorsUpdatedAt: null,
    locksUpdatedAt: null,
    windowsUpdatedAt: null,
    chargeUpdatedAt: null,
    source: "android",
    observedAt: Date.parse(s.observedAt),
    reportedUpdatedText: s.reportedUpdatedText,
    closuresKnown: false,
    climateOn: s.climateOn,
    targetTempF: s.targetTempF,
    minutesToTarget: s.minutesToTarget,
  });
}
