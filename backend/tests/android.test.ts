import { beforeEach, describe, expect, it, vi } from "vitest";
import { seal } from "../src/crypto";
import type { AppEnv } from "../src/env";
import { toStatus, type PhoneJob } from "../src/vehicle/android";
import { AndroidGateway } from "../src/vehicle/gateway";

const saveSnapshot = vi.hoisted(() => vi.fn());
const getActiveClimateSession = vi.hoisted(() => vi.fn());
vi.mock("../src/store", () => ({
  getDb: vi.fn(),
  getActiveClimateSession,
  saveSnapshot,
  recordVehicleOperation: vi.fn().mockResolvedValue(undefined),
  startClimateSession: vi.fn(),
  endClimateSession: vi.fn(),
}));
const key = btoa("a".repeat(32));
const vin = "WVWZZZ1JZXW000001";
const status = {
  vin,
  soc: 50,
  rangeKm: 200,
  chargeState: "Charging complete",
  targetSoc: 80,
  locked: false,
  minutesToTarget: 20,
  observedAt: "2026-10-21T00:00:00Z",
  reportedUpdatedText: "Updated at 5:00PM",
  climateOn: false,
  targetTempF: 72,
};

function setup() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn((key: string) => Promise.resolve(values.get(key))),
    put: vi.fn((key: string, value: unknown) => {
      values.set(key, structuredClone(value));
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => Promise.resolve(values.delete(key))),
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
    transaction: async <T>(cb: (s: unknown) => Promise<T>) => cb(storage),
  };
  const ctx = { storage } as unknown as DurableObjectState;
  const env = {
    CREDS_ENC_KEY: key,
    ANDROID_BRIDGE_URL: "https://bridge.example",
    ANDROID_BRIDGE_KEY: "test-key",
  } as AppEnv;
  return { gateway: new AndroidGateway(ctx, env), values, storage };
}
async function job(): Promise<PhoneJob> {
  return {
    requestId: crypto.randomUUID(),
    accountId: "account-a",
    operation: "status",
    vin,
    params: {},
    sealed: await seal(
      key,
      JSON.stringify({
        username: "a@example.com",
        password: "secret-password",
      }),
    ),
    completion: { vehicleId: "vehicle-a" },
  };
}
function submit(g: AndroidGateway, j: PhoneJob) {
  return g.fetch(
    new Request("https://gateway/jobs", {
      method: "POST",
      body: JSON.stringify(j),
    }),
  );
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("phone status normalization", () => {
  it("keeps observation time separate, and never invents closure or charging data", () => {
    const s = toStatus(status);
    expect(s.capturedAt).toBeNull();
    expect(s.closuresKnown).toBe(false);
    expect(s.chargeState).toBe("complete");
    expect(s.minutesToFull).toBeNull();
    expect(s.minutesToTarget).toBe(20);
    expect(s.pluggedIn).toBeNull();
    expect(s.observedAt).toBe(Date.parse(status.observedAt));
  });
});
describe("durable phone coordinator", () => {
  it("serializes admission, reuses IDs, and rejects cross-account reuse", async () => {
    const { gateway, values } = setup();
    const j = await job();
    expect((await submit(gateway, j)).status).toBe(200);
    expect(values.has("pending")).toBe(true);
    expect((await submit(gateway, j)).status).toBe(200);
    expect(
      (
        await submit(gateway, {
          ...j,
          requestId: crypto.randomUUID(),
          background: true,
        })
      ).status,
    ).toBe(409);
    expect((await submit(gateway, { ...j, accountId: "other" })).status).toBe(
      422,
    );
  });
  it("recovers an accepted job after a lost submission response without reissuing it", async () => {
    const { gateway, values, storage } = setup();
    const j = await job();
    await submit(gateway, j);
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockRejectedValueOnce(new Error("network"));
    await gateway.alarm();
    expect(values.has("pending")).toBe(true);
    expect(storage.setAlarm).toHaveBeenCalled();
    fetch.mockResolvedValueOnce(
      Response.json({
        requestId: j.requestId,
        state: "succeeded",
        result: status,
      }),
    );
    await gateway.alarm();
    expect(fetch).toHaveBeenCalledTimes(3); // GET + POST, then GET only
    expect(values.has("pending")).toBe(false);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveSnapshot.mock.calls[0]?.[3]).toEqual({
      snapshotId: j.requestId,
    });
    expect((await submit(gateway, j)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("retries database finalization without talking to the phone again", async () => {
    const { gateway, values } = setup();
    const j = await job();
    await submit(gateway, j);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        requestId: j.requestId,
        state: "succeeded",
        result: status,
      }),
    );
    saveSnapshot.mockRejectedValueOnce(new Error("database unavailable"));
    await gateway.alarm();
    expect(values.has("pending")).toBe(true);
    saveSnapshot.mockResolvedValueOnce(true);
    await gateway.alarm();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(values.has("pending")).toBe(false);
  });
  it("makes explicit phone errors terminal and never falls back to VW HTTP", async () => {
    const { gateway, values } = setup();
    const j = await job();
    await submit(gateway, j);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        requestId: j.requestId,
        state: "failed",
        error: {
          code: "APP_VERSION_CHANGED",
          message: "Update selectors",
          retryable: false,
        },
      }),
    );
    await gateway.alarm();
    expect(values.has("pending")).toBe(false);
    expect(values.get(`result:${j.requestId}`)).toMatchObject({
      state: "failed",
      error: { code: "APP_VERSION_CHANGED" },
    });
    expect(saveSnapshot).not.toHaveBeenCalled();
  });
});

it("queues an interactive request durably and expires stale work without sending it", async () => {
  const { gateway, values } = setup();
  const first = await job();
  const second = await job();
  await submit(gateway, first);
  expect((await submit(gateway, second)).status).toBe(200);
  const queue = values.get("queue") as { job: PhoneJob; createdAt: number }[];
  const entry = queue[0];
  if (!entry) throw new Error("queue missing");
  entry.createdAt = Date.now() - 180_000;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      requestId: first.requestId,
      state: "succeeded",
      result: status,
    }),
  );
  await gateway.alarm();
  expect(values.get("pending")).toMatchObject({
    job: { requestId: second.requestId },
  });
  await gateway.alarm();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(values.get(`result:${second.requestId}`)).toMatchObject({
    state: "failed",
    error: { code: "REQUEST_EXPIRED" },
  });
});

it("rejects bridge redirects without forwarding credentials", async () => {
  const { gateway, values } = setup();
  const j = await job();
  await submit(gateway, j);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { Location: "https://untrusted.example" },
    }),
  );
  await gateway.alarm();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
  expect(values.get(`result:${j.requestId}`)).toMatchObject({
    state: "failed",
    error: { code: "BRIDGE_CONFIGURATION" },
  });
});

it("does not run stale climate keepalive work after a newer session starts", async () => {
  const { gateway, values } = setup();
  const j = { ...(await job()), climateSessionId: "old-session" };
  await submit(gateway, j);
  getActiveClimateSession.mockResolvedValue({
    id: "new-session",
    expiresAt: Date.now() + 60000,
  });
  const fetch = vi.spyOn(globalThis, "fetch");
  await gateway.alarm();
  expect(fetch).not.toHaveBeenCalled();
  expect(values.get(`result:${j.requestId}`)).toMatchObject({
    state: "failed",
    error: { code: "STALE_SESSION" },
  });
});
