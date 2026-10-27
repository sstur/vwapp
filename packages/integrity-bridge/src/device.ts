import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./protocol.ts";

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export type Shell = (args: string[], check?: boolean) => Promise<string>;
export function adbShell(config: Config): Shell {
  return (args, check = true) =>
    new Promise((resolve, reject) => {
      execFile(
        config.adb,
        ["-s", config.serial, "shell", args.map(shellQuote).join(" ")],
        { timeout: 15000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          if (
            error &&
            (check || typeof error.code !== "number" || error.killed)
          ) {
            reject(new Error("ADB_UNAVAILABLE"));
          } else resolve(stdout.trim());
        },
      );
    });
}

export async function readyDevice(
  config: Config,
  shell: Shell = adbShell(config),
  sleep: (ms: number) => Promise<void> = delay,
): Promise<number> {
  async function pid(name: string) {
    const value = await shell(["pidof", name], false);
    if (!value) return null;
    const first = value.split(/\s+/)[0];
    if (!first || !/^\d+$/.test(first)) throw new Error("INVALID_PID");
    const result = Number(first);
    if (!Number.isSafeInteger(result) || result <= 0)
      throw new Error("INVALID_PID");
    return result;
  }
  if ((await shell(["getprop", "sys.boot_completed"])) !== "1") {
    throw new Error("DEVICE_NOT_BOOTED");
  }
  const version = await shell(["dumpsys", "package", config.package]);
  if (/\bversionCode=(\d+)\s/.exec(version)?.[1] !== config.versionCode) {
    throw new Error("UNSUPPORTED_APP_VERSION");
  }
  if ((await pid("frida-server")) === null) {
    await shell([
      "su",
      "-c",
      shellQuote(config.fridaServer) + " -D </dev/null >/dev/null 2>&1",
    ]);
    let started = false;
    for (let i = 0; i < 20; i++) {
      if ((await pid("frida-server")) !== null) {
        started = true;
        break;
      }
      await sleep(250);
    }
    if (!started) throw new Error("FRIDA_NOT_STARTED");
  }
  let appPid = await pid(config.package);
  if (appPid === null) {
    await shell(["am", "start", "-n", config.package + "/" + config.activity]);
    for (let i = 0; i < 40; i++) {
      appPid = await pid(config.package);
      if (appPid !== null) break;
      await sleep(250);
    }
    if (appPid === null) throw new Error("APP_NOT_STARTED");
    // Android 16 changes ART collectors after launch; attaching during that
    // transition crashes HeapTaskDaemon. Preserve the verified 10-second wait.
    await sleep(10000);
  }
  if (
    (await shell(["cmd", "activity", "isfrozen", String(appPid)])) === "true"
  ) {
    await shell(["cmd", "activity", "unfreeze", String(appPid)]);
  }
  return appPid;
}
