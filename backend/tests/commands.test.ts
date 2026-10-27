/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  vwAwaitCommandResult,
  VwCommandError,
  vwForceRefresh,
  vwLockUnlock,
} from "../src/vw/client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

void test("vehicle writes use coordinated carnet tokens without their own PIN challenge", async () => {
  const requests: {
    path: string;
    method: string | undefined;
    body: unknown;
  }[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer coordinated-carnet",
    );
    requests.push({
      path: new URL(url instanceof Request ? url.url : url).pathname,
      method: init?.method,
      body: init?.body,
    });
    return Response.json({ data: { result: 0, correlationId: "command-id" } });
  };
  assert.equal(
    await vwLockUnlock("coordinated-carnet", "vehicle", "lock"),
    "command-id",
  );
  await vwForceRefresh("coordinated-carnet", "vehicle");
  assert.deepEqual(requests, [
    {
      path: "/lockunlock/v1/vehicle/vehicle",
      method: "PUT",
      body: '{"lock":true}',
    },
    {
      path: "/rvs/v1/vehicle/vehicle/refresh",
      method: "POST",
      body: undefined,
    },
  ]);
});

void test("accepted command is not terminal; only a success result confirms it", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    Response.json({
      data: {
        responseBody: JSON.stringify({
          eventStatus: { responseOutcome: ++calls === 1 ? 1 : 2 },
        }),
      },
    });
  assert.deepEqual(
    await vwAwaitCommandResult("carnet", "vehicle", "command", {
      attempts: 2,
      intervalMs: 0,
    }),
    { confirmed: true },
  );
  assert.equal(calls, 2);
  globalThis.fetch = async () =>
    Response.json({
      data: {
        responseBody: JSON.stringify({ eventStatus: { responseOutcome: 1 } }),
      },
    });
  assert.deepEqual(
    await vwAwaitCommandResult("carnet", "vehicle", "command", {
      attempts: 1,
      intervalMs: 0,
    }),
    { confirmed: false },
  );
});

void test("a vehicle rejection never becomes a successful command", async () => {
  globalThis.fetch = async () =>
    Response.json({
      data: {
        responseBody: JSON.stringify({
          eventStatus: { responseOutcome: 3, responseCode: "RO_DOOR_FAILED" },
        }),
      },
    });
  await assert.rejects(
    vwAwaitCommandResult("carnet", "vehicle", "command", {
      attempts: 1,
      intervalMs: 0,
    }),
    VwCommandError,
  );
});
