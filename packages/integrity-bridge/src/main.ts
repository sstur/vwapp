import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChild } from "./child.ts";
import { readConfig, tokenSchema } from "./protocol.ts";
import { createBridge } from "./server.ts";

process.umask(0o077);
try {
  const configArg =
    process.argv[2] === "--config" ? process.argv[3] : undefined;
  if (!configArg) throw new Error("MISSING_CONFIG");
  const configPath = resolve(configArg);
  const config = await readConfig(configPath);
  const server = createBridge(config, async (body) => {
    const raw = await runChild({
      executable: process.execPath,
      args: [fileURLToPath(new URL("./mint.js", import.meta.url)), configPath],
      input: JSON.stringify(body),
      timeoutMs: 75000,
    });
    const data: unknown = JSON.parse(raw);
    return tokenSchema.parse(data);
  });
  server.on("error", () => {
    console.error("Bridge listener failed");
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log("VW integrity bridge ready");
  });
  // Finish any in-flight renewal before exiting; launchd can restart safely.
  process.on("SIGTERM", () => {
    server.close();
  });
  process.on("SIGINT", () => {
    server.close();
  });
} catch {
  console.error("Bridge startup failed: check private config and installation");
  process.exitCode = 1;
}
