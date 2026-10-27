import Java from "frida-java-bridge";

// APK members are dynamically resolved and Frida types them as any. Keep that
// boundary unknown, check member shapes, and validate outputs on the Node side.
function member(target: unknown, name: string): unknown {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function")
  ) {
    throw new Error("INVALID_JAVA_OBJECT");
  }
  return Reflect.get(target, name);
}
function invoke(target: unknown, name: string, ...args: unknown[]): unknown {
  const method = member(target, name);
  if (typeof method !== "function") throw new Error("MISSING_JAVA_METHOD");
  return Reflect.apply(method, target, args);
}
function setField(target: unknown, name: string, value: unknown): void {
  const field = member(target, name);
  if (
    field === null ||
    typeof field !== "object" ||
    !Reflect.set(field, "value", value)
  ) {
    throw new Error("INVALID_JAVA_FIELD");
  }
}
function cast(value: unknown, className: string): Java.Wrapper {
  const handle = member(value, "$h");
  if (!(handle instanceof NativePointer))
    throw new Error("INVALID_JAVA_HANDLE");
  return Java.cast(handle, Java.use(className));
}
function retain(value: unknown): Java.Wrapper {
  const className = member(value, "$className");
  if (typeof className !== "string") throw new Error("INVALID_JAVA_CLASS");
  return Java.retain(cast(value, className));
}
function run<T>(fn: () => T): T {
  let result: { value: T } | undefined;
  Java.performNow(() => {
    result = { value: fn() };
  });
  if (!result) throw new Error("JAVA_NOT_READY");
  return result.value;
}
let task: unknown = null;
let provider: unknown = null;
let kind: "prepare" | "request" | null = null;
rpc.exports = {
  prepare() {
    return run(() => {
      const app = invoke(
        Java.use("android.app.ActivityThread"),
        "currentApplication",
      );
      const ctx = invoke(app, "getApplicationContext");
      const mgr = invoke(Java.use("fkn"), "e", ctx);
      const req = invoke(Java.use("z1k"), "$new");
      setField(req, "a", 820996449805);
      task = retain(invoke(mgr, "a", req));
      kind = "prepare";
      return { started: true };
    });
  },
  request(requestHash: unknown) {
    if (
      typeof requestHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}=$/.test(requestHash)
    ) {
      throw new Error("INVALID_HASH");
    }
    return run(() => {
      if (!provider) throw new Error("INTEGRITY_NOT_READY");
      const req = invoke(Java.use("c3k"), "$new");
      setField(req, "a", requestHash);
      setField(req, "b", invoke(Java.use("java.util.Collections"), "emptySet"));
      task = retain(invoke(provider, "a", req));
      kind = "request";
      return { started: true };
    });
  },
  poll() {
    return run(() => {
      if (!task) return { error: "NO_TASK" };
      if (invoke(task, "l") !== true) return { pending: true };
      if (invoke(task, "m") !== true) return { error: "INTEGRITY_REJECTED" };
      const result = invoke(task, "k");
      if (kind === "prepare") {
        provider = Java.retain(cast(result, "l0k"));
        return { ready: true };
      }
      const token = member(member(cast(result, "k0k"), "a"), "value");
      if (typeof token !== "string") throw new Error("INVALID_TOKEN");
      return { token };
    });
  },
};
