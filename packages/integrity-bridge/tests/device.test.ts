import assert from "node:assert/strict";
import { test } from "node:test";
import { readyDevice, shellQuote, type Shell } from "../src/device.ts";
import { configSchema, pollSchema, requestSchema } from "../src/protocol.ts";
import { config, request } from "./fixtures.ts";

function device(
  options: {
    cold?: boolean;
    frozen?: boolean;
    booted?: boolean;
    wrongVersion?: boolean;
    fridaFails?: boolean;
    appFails?: boolean;
    badPid?: boolean;
  } = {},
) {
  let frida = !options.cold,
    app = !options.cold;
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const shell: Shell = (args) => {
    calls.push(args);
    const [command, name] = args;
    if (command === "getprop")
      return Promise.resolve(options.booted === false ? "0" : "1");
    if (command === "dumpsys")
      return Promise.resolve(
        "versionCode=" +
          (options.wrongVersion ? "999" : config.versionCode) +
          " minSdk=28",
      );
    if (command === "pidof")
      return Promise.resolve(
        name === "frida-server"
          ? frida
            ? "10"
            : ""
          : app
            ? options.badPid
              ? "not-a-pid"
              : "20"
            : "",
      );
    if (command === "su") frida = !options.fridaFails;
    if (command === "am") app = !options.appFails;
    if (command === "cmd" && args[2] === "isfrozen")
      return Promise.resolve(options.frozen ? "true" : "false");
    return Promise.resolve("");
  };
  return {
    calls,
    sleeps,
    run: () =>
      readyDevice(config, shell, (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      }),
  };
}
void test("warm sleeping app is reused without launch or delays", async () => {
  const d = device();
  assert.equal(await d.run(), 20);
  assert.deepEqual(d.sleeps, []);
  assert.equal(
    d.calls.some(([c]) => c === "am" || c === "su"),
    false,
  );
});
void test("cold recovery starts Frida, waits for ART, and unfreezes without a wake command", async () => {
  const d = device({ cold: true, frozen: true });
  assert.equal(await d.run(), 20);
  assert.deepEqual(d.sleeps, [10000]);
  assert.ok(d.calls.some(([c]) => c === "su"));
  assert.deepEqual(
    d.calls.find(([c]) => c === "am"),
    ["am", "start", "-n", config.package + "/" + config.activity],
  );
  assert.deepEqual(d.calls.at(-1), ["cmd", "activity", "unfreeze", "20"]);
  assert.equal(
    d.calls.some(([c]) => c === "input"),
    false,
  );
});
void test("unsupported APK and incomplete boot stop before launching or attaching", async () => {
  for (const options of [{ wrongVersion: true }, { booted: false }]) {
    const d = device(options);
    await assert.rejects(d.run());
    assert.equal(
      d.calls.some(([c]) => c === "su" || c === "am" || c === "pidof"),
      false,
    );
  }
});
void test("Frida/app startup failures and malformed PIDs fail closed", async () => {
  await assert.rejects(
    device({ cold: true, fridaFails: true }).run(),
    /FRIDA_NOT_STARTED/,
  );
  await assert.rejects(
    device({ cold: true, appFails: true }).run(),
    /APP_NOT_STARTED/,
  );
  await assert.rejects(device({ badPid: true }).run(), /INVALID_PID/);
});
void test("ADB shell arguments are individually quoted, including apostrophes", () => {
  assert.equal(shellQuote("/tmp/it's $(unsafe)"), "'/tmp/it'\\''s $(unsafe)'");
});
void test("config and RPC boundaries reject unexpected shapes", () => {
  assert.deepEqual(configSchema.parse(config), config);
  assert.equal(
    configSchema.safeParse({ ...config, apiKey: "short" }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ ...config, adb: "adb" }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ ...config, port: "8791" }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ ...config, versionCode: "123.*" }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ ...config, password: "secret" }).success,
    false,
  );
  assert.deepEqual(requestSchema.parse(request), request);
  assert.equal(pollSchema.safeParse({ token: "short" }).success, false);
  assert.equal(pollSchema.safeParse({ pending: false }).success, false);
  assert.equal(
    pollSchema.safeParse({ ready: true, token: "secret" }).success,
    false,
  );
});
