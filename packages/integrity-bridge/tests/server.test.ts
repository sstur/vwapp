import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test, type TestContext } from "node:test";
import { createBridge } from "../src/server.ts";
import { config, deferred, request, token } from "./fixtures.ts";

async function fixture(
  t: TestContext,
  mint: Parameters<typeof createBridge>[1],
) {
  const server = createBridge(config, mint);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      }),
  );
  const url = `http://127.0.0.1:${String(address.port)}`;
  return {
    url,
    post(body: unknown = request, path = "/v1/integrity", auth = true) {
      return fetch(url + path, {
        method: "POST",
        headers: auth ? { authorization: "Bearer " + config.apiKey } : {},
        body: JSON.stringify(body),
      });
    },
    health() {
      return fetch(url + "/healthz", {
        headers: { authorization: "Bearer " + config.apiKey },
      });
    },
  };
}
void test("auth, route and strict payload validation prevent native calls", async (t) => {
  let calls = 0;
  const f = await fixture(t, () => {
    calls++;
    return Promise.resolve(token);
  });
  assert.equal((await f.post(request, "/v1/integrity", false)).status, 401);
  assert.equal((await fetch(f.url + "/healthz")).status, 401);
  assert.equal((await f.post(request, "/command")).status, 404);
  for (const body of [
    { password: "secret" },
    { requestHash: "short" },
    { ...request, token: "secret" },
    [],
    null,
    { requestHash: request.requestHash + "\n" },
    { requestHash: "a".repeat(43) },
  ]) {
    assert.equal((await f.post(body)).status, 400);
  }
  const malformed = await fetch(f.url + "/v1/integrity", {
    method: "POST",
    headers: { authorization: "Bearer " + config.apiKey },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await f.post({ requestHash: "a".repeat(2048) })).status, 400);
  assert.equal(calls, 0);
});
void test("chunked requests are refused without touching the phone", async (t) => {
  const f = await fixture(t, () => {
    throw new Error("must not mint");
  });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      f.url + "/v1/integrity",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.apiKey,
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(request));
  });
  assert.equal(status, 400);
});
void test("every mint is fresh, uncached, and health records success only", async (t) => {
  let calls = 0;
  const f = await fixture(t, (body) => {
    assert.deepEqual(body, request);
    return Promise.resolve({ token: token.token + String(++calls) });
  });
  assert.deepEqual(await (await f.health()).json(), {
    ok: true,
    service: "vw-integrity",
    lastSuccessAt: null,
  });
  const a = await f.post();
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("cache-control"), "no-store");
  const first: unknown = await a.json();
  const second: unknown = await (await f.post()).json();
  assert.notDeepEqual(first, second);
  const health: unknown = await (await f.health()).json();
  assert.ok(
    typeof health === "object" &&
      health !== null &&
      "lastSuccessAt" in health &&
      typeof health.lastSuccessAt === "number",
  );
  assert.equal(calls, 2);
});
void test("overlapping requests are refused while health stays responsive; failure releases the slot", async (t) => {
  const entered = deferred<undefined>(),
    release = deferred<undefined>();
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) {
      entered.resolve(undefined);
      await release.promise;
      throw new Error("private provider diagnostics");
    }
    return token;
  });
  const first = f.post();
  await entered.promise;
  try {
    const busy = await f.post();
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { error: "BRIDGE_BUSY" });
    assert.equal((await f.health()).status, 200);
    assert.equal(calls, 1);
  } finally {
    release.resolve(undefined);
  }
  const failed = await first;
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "INTEGRITY_UNAVAILABLE" });
  assert.equal((await f.post()).status, 200);
});
void test("invalid native token fails closed and is never reflected to callers", async (t) => {
  const f = await fixture(t, () => Promise.resolve({ token: "secret" }));
  const response = await f.post();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "INTEGRITY_UNAVAILABLE" });
  assert.deepEqual(await (await f.health()).json(), {
    ok: true,
    service: "vw-integrity",
    lastSuccessAt: null,
  });
});
