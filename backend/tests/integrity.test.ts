/* Test doubles deliberately return immediate promises. */
/* eslint-disable @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import type { AppEnv } from "../src/env";
import {
  integrityProvider,
  integrityRequestHash,
  IntegrityUnavailableError,
} from "../src/integrity";
import { SerialQueue } from "../src/serial";
import { vwLogin, vwRefresh, VwUnavailableError } from "../src/vw/client";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const env = {
  INTEGRITY_BRIDGE_URL: "https://bridge.example",
  INTEGRITY_BRIDGE_KEY: "private-key",
} as AppEnv;

void test("request binding uses padded base64url SHA256", async () => {
  assert.equal(
    await integrityRequestHash("refresh-value"),
    createHash("sha256")
      .update("refresh-value")
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_"),
  );
  assert.equal((await integrityRequestHash("refresh-value")).length, 44);
});
void test("bridge sees only a hash and an authenticated request; tokens are fresh per call", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "",
    ) as { requestHash: string };
    assert.deepEqual(Object.keys(body), ["requestHash"]);
    assert.equal(
      body.requestHash,
      await integrityRequestHash("private-refresh"),
    );
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer private-key",
    );
    assert.equal(init?.redirect, "manual");
    return Response.json({ token: "x".repeat(150) + String(calls) });
  };
  const provider = integrityProvider(env);
  assert.notEqual(
    await provider("private-refresh"),
    await provider("private-refresh"),
  );
});
void test("bridge errors are infrastructure failures, not leaked upstream text", async () => {
  globalThis.fetch = async () =>
    new Response("secret diagnostic", { status: 503 });
  await assert.rejects(
    integrityProvider(env)("private"),
    IntegrityUnavailableError,
  );
  globalThis.fetch = async () => Response.json({ token: "short" });
  await assert.rejects(
    integrityProvider(env)("private"),
    IntegrityUnavailableError,
  );
});
void test("offline bridge prevents password submission", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not contact VW");
  };
  await assert.rejects(
    vwLogin("user", "password", async () => {
      throw new IntegrityUnavailableError();
    }),
    IntegrityUnavailableError,
  );
  assert.equal(calls, 0);
});
void test("refresh binds attestation to refresh token and retains original PKCE verifier", async () => {
  globalThis.fetch = async (_url, init) => {
    const form = new URLSearchParams(
      typeof init?.body === "string" ? init.body : "",
    );
    assert.equal(form.get("play_integrity_token"), "real-attestation");
    assert.equal(form.get("code_verifier"), "original-verifier");
    assert.equal(form.get("grant_type"), "refresh_token");
    return Response.json({
      access_token: "new-access",
      id_token: "new-id",
      expires_in: 1800,
    });
  };
  const result = await vwRefresh(
    "old-refresh",
    "original-verifier",
    async (binding) => {
      assert.equal(binding, "old-refresh");
      return "real-attestation";
    },
  );
  assert.equal(result.refreshToken, "old-refresh");
  assert.equal(result.codeVerifier, "original-verifier");
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(
    vwRefresh("r", "v", async () => "pi"),
    VwUnavailableError,
  );
});
void test("serialized auth work never overlaps and recovers after rejection", async () => {
  const queue = new SerialQueue();
  let active = 0;
  let peak = 0;
  const job = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return 1;
  };
  const results = await Promise.all([
    queue.run(job),
    queue.run(job),
    queue.run(job),
  ]);
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(peak, 1);
  await assert.rejects(queue.run(() => Promise.reject(new Error("test"))));
  assert.equal(await queue.run(job), 1);
});
