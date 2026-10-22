import { expect, it, vi } from "vitest";
import { saveConfirmedChargeLimit, type Db } from "../src/store";

it("appends a confirmed setting without making older telemetry appear freshly read", async () => {
  const latest = {
    id: "old",
    source: "android",
    targetSoc: 100,
    observedAt: 1000,
    odometerObservedAt: 500,
    odometerKm: 48130,
    createdAt: 1001,
  };
  const link = vi.fn().mockReturnValue("transaction");
  const update = vi.fn().mockReturnValue({ link });
  const transact = vi.fn();
  const db = {
    query: vi.fn().mockResolvedValue({ snapshots: [latest] }),
    tx: { snapshots: { request: { update } } },
    transact,
  } as unknown as Db;
  await saveConfirmedChargeLimit(db, "vehicle", 90, "request");
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      targetSoc: 90,
      observedAt: 1000,
      odometerObservedAt: 500,
      odometerKm: 48130,
    }),
  );
  expect(update.mock.calls[0]?.[0]).not.toHaveProperty("id");
  expect(link).toHaveBeenCalledWith({ vehicle: "vehicle" });
  expect(transact).toHaveBeenCalledWith("transaction");
  latest.id = "request";
  await saveConfirmedChargeLimit(db, "vehicle", 90, "request");
  expect(update).toHaveBeenCalledTimes(1);
});
