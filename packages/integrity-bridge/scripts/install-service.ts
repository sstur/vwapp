/** Install the built Node service, restoring the prior job if startup fails. */
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { readConfig } from "../src/protocol.ts";
import { serviceNodeExecutable } from "./node-executable.ts";

const exec = promisify(execFile);
function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
async function main() {
  process.umask(0o077);
  if (process.platform !== "darwin" || !process.getuid)
    throw new Error("MACOS_REQUIRED");
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      label: { type: "string", default: "com.vwapp.integrity-bridge" },
      node: { type: "string" },
    },
  });
  if (!values.config) throw new Error("MISSING_CONFIG");
  const label = z
    .string()
    .regex(/^com\.vwapp\.integrity-bridge(?:-[a-z0-9]+)?$/)
    .parse(values.label);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const configPath = resolve(values.config);
  const config = await readConfig(configPath);
  await access(join(root, "dist/main.js"));
  await access(join(root, "dist/integrity-agent.js"));
  const nodeExecutable = serviceNodeExecutable(process.execPath, values.node);
  await exec(
    nodeExecutable,
    [
      "--eval",
      "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)",
    ],
    { timeout: 10000 },
  );
  const pnpm = process.env["npm_execpath"];
  if (!pnpm) throw new Error("RUN_INSTALLER_WITH_PNPM");
  // Each deployment owns its code and production dependencies outside the
  // checkout. Cleaning node_modules or switching branches cannot break it.
  const releases = join(dirname(configPath), "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const runtime = await mkdtemp(join(releases, label + "-"));
  try {
    await exec(
      nodeExecutable,
      [
        pnpm,
        "--filter",
        "@vwapp/integrity-bridge",
        "deploy",
        "--legacy",
        "--prod",
        runtime,
      ],
      { cwd: root, timeout: 180000, maxBuffer: 1024 * 1024 },
    );
    await cp(join(root, "dist"), join(runtime, "dist"), { recursive: true });
    // Import native Frida as well: listener health alone cannot detect missing
    // mint-process dependencies. Do this before touching the running service.
    await exec(
      nodeExecutable,
      [
        "--input-type=module",
        "--eval",
        "await import('zod'); await import('frida');",
      ],
      { cwd: runtime, timeout: 15000 },
    );
  } catch {
    await rm(runtime, { recursive: true, force: true });
    throw new Error("RUNTIME_PREFLIGHT_FAILED");
  }
  await chmod(configPath, 0o600);
  const plist = join(homedir(), "Library/LaunchAgents", label + ".plist");
  await mkdir(dirname(plist), { recursive: true });
  const domain = "gui/" + String(process.getuid());
  let previous: Buffer | undefined;
  try {
    previous = await readFile(plist);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  if (previous)
    await writeFile(
      join(dirname(configPath), label + ".previous.plist"),
      previous,
      { mode: 0o600 },
    );
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>ExitTimeOut</key><integer>90</integer>
<key>WorkingDirectory</key><string>${xml(runtime)}</string>
<key>ProgramArguments</key><array><string>${xml(nodeExecutable)}</string><string>${xml(join(runtime, "dist/main.js"))}</string><string>--config</string><string>${xml(configPath)}</string></array>
<key>EnvironmentVariables</key><dict><key>VW_INTEGRITY_NODE</key><string>${xml(nodeExecutable)}</string></dict>
<key>StandardOutPath</key><string>${xml(join(dirname(configPath), label + ".log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(dirname(configPath), label + "-error.log"))}</string>
</dict></plist>
`;
  await writeFile(plist + ".tmp", content, { mode: 0o600 });
  await exec("/usr/bin/plutil", ["-lint", plist + ".tmp"]);
  async function bootout() {
    // An absent job is fine; other errors must not silently replace a running job.
    const present = await exec("/bin/launchctl", [
      "print",
      domain + "/" + label,
    ]).then(
      () => true,
      () => false,
    );
    if (present)
      await exec("/bin/launchctl", ["bootout", domain + "/" + label]);
  }
  async function bootstrap() {
    // bootout returns before launchd always finishes unregistering the job.
    // Immediate bootstrap can return EIO; retry that transition for rollback too.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await exec("/bin/launchctl", ["bootstrap", domain, plist]);
        return;
      } catch {
        await delay(250);
      }
    }
    throw new Error("LAUNCHD_BOOTSTRAP_FAILED");
  }
  try {
    await bootout();
    await rename(plist + ".tmp", plist);
    await bootstrap();
    let healthy = false;
    const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    for (let i = 0; i < 20; i++) {
      try {
        const response = await fetch(
          `http://${host}:${String(config.port)}/healthz`,
          {
            headers: { authorization: "Bearer " + config.apiKey },
            signal: AbortSignal.timeout(1000),
          },
        );
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        /* startup may still be in progress */
      }
      await delay(250);
    }
    if (!healthy) throw new Error("STARTUP_FAILED");
    console.log("Installed and healthy: " + label);
  } catch {
    await bootout();
    if (previous) {
      await writeFile(plist, previous, { mode: 0o600 });
      await bootstrap();
      console.error("Previous LaunchAgent restored after failed installation");
    } else await rm(plist, { force: true });
    throw new Error("INSTALL_FAILED_PREVIOUS_JOB_RESTORED");
  } finally {
    await rm(plist + ".tmp", { force: true });
  }
}
try {
  await main();
} catch {
  console.error(
    "Bridge installation failed; check local launchd state. Prior job restoration was attempted.",
  );
  process.exitCode = 1;
}
