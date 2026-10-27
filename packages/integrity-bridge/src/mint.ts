import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getDevice, type Script } from "frida";
import { readyDevice } from "./device.ts";
import {
  pollSchema,
  readConfig,
  requestSchema,
  startedSchema,
  tokenSchema,
} from "./protocol.ts";

async function call(
  script: Script,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = script.exports[method];
  if (!fn) throw new Error("MISSING_RPC");
  // Frida's declarations return any. All RPC data stays unknown until parsed.
  const result: unknown = await fn(...args);
  return result;
}
async function wait(script: Script) {
  const until = performance.now() + 25000;
  while (performance.now() < until) {
    const result = pollSchema.parse(await call(script, "poll"));
    if ("error" in result) throw new Error("INTEGRITY_REJECTED");
    if (!("pending" in result)) return result;
    await delay(200);
  }
  throw new Error("INTEGRITY_TIMEOUT");
}
async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("MISSING_CONFIG");
  const config = await readConfig(configPath);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Buffer)) throw new Error("INVALID_INPUT");
    size += chunk.length;
    if (size > 1024) throw new Error("INVALID_INPUT");
    chunks.push(chunk);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const body = requestSchema.parse(input);
  const pid = await readyDevice(config);
  const device = await getDevice(config.serial, { timeout: 10000 });
  const session = await device.attach(pid);
  let script: Script | undefined;
  try {
    script = await session.createScript(
      await readFile(new URL("./integrity-agent.js", import.meta.url), "utf8"),
    );
    // The provider may log sensitive diagnostics; never forward native logs.
    script.logHandler = () => undefined;
    await script.load();
    startedSchema.parse(await call(script, "prepare"));
    if (!("ready" in (await wait(script))))
      throw new Error("INTEGRITY_NOT_READY");
    startedSchema.parse(await call(script, "request", body.requestHash));
    const token = tokenSchema.parse(await wait(script));
    process.stdout.write(JSON.stringify(token));
  } finally {
    try {
      await script?.unload();
    } finally {
      await session.detach();
    }
  }
}
try {
  await main();
  // Native Frida threads must not outlive this isolated request.
  process.exitCode = 0;
} catch {
  process.stdout.write(JSON.stringify({ error: "INTEGRITY_UNAVAILABLE" }));
  process.exitCode = 1;
}
