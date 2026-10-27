import type { Config } from "../src/protocol.ts";

export const config: Config = {
  serial: "TEST_SERIAL",
  adb: "/test/adb",
  apiKey: "a".repeat(48),
  host: "127.0.0.1",
  port: 8791,
  package: "com.vw.carnet.release",
  versionCode: "1800220674",
  activity: "com.vw.myVW.activities.RoutingActivity",
  fridaServer: "/data/local/tmp/frida-server",
};
export const request = { requestHash: "a".repeat(43) + "=" };
export const token = { token: "private-token".repeat(20) };
export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("NOT_INITIALIZED");
  };
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
