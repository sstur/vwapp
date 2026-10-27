import Java from "frida-java-bridge";

let task = null,
  provider = null,
  kind = null;
function run(fn) {
  let out;
  Java.performNow(() => {
    out = fn();
  });
  return out;
}
rpc.exports = {
  prepare() {
    return run(() => {
      const ctx = Java.use("android.app.ActivityThread")
        .currentApplication()
        .getApplicationContext();
      const mgr = Java.use("fkn").e(ctx);
      const req = Java.use("z1k").$new();
      req.a.value = 820996449805;
      task = Java.retain(mgr.a(req));
      kind = "prepare";
      return { started: true };
    });
  },
  request(requestHash) {
    return run(() => {
      if (!provider) throw Error("prepare first");
      const req = Java.use("c3k").$new();
      req.a.value = requestHash;
      req.b.value = Java.use("java.util.Collections").emptySet();
      task = Java.retain(provider.a(req));
      kind = "request";
      return { started: true };
    });
  },
  poll() {
    return run(() => {
      if (!task) return { error: "no task" };
      if (!task.l()) return { pending: true };
      if (!task.m()) return { error: task.j().toString() };
      const result = task.k();
      if (kind === "prepare") {
        provider = Java.retain(Java.cast(result, Java.use("l0k")));
        return { ready: true };
      }
      return { token: Java.cast(result, Java.use("k0k")).a.value };
    });
  },
};
