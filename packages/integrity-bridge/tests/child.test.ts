import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runChild } from "../src/child.ts";

function run(source: string, timeoutMs = 1000) {
  return runChild({
    executable: process.execPath,
    args: ["-e", source],
    input: "private-input",
    timeoutMs,
  });
}
void test("isolated child receives stdin and returns stdout only", async () => {
  const out = await run(
    'process.stdin.pipe(process.stdout); console.error("private diagnostic");',
  );
  assert.equal(out, "private-input");
});
void test("crashes, failed spawn and oversized output reject without leaking diagnostics", async () => {
  await assert.rejects(run('console.log("private token"); process.exit(1);'), {
    message: "MINT_CHILD_FAILED",
  });
  await assert.rejects(
    run('process.stdout.write("x".repeat(70000)); setInterval(()=>{}, 1000);'),
    { message: "MINT_CHILD_FAILED" },
  );
  await assert.rejects(
    runChild({
      executable: "/no/such/binary",
      args: [],
      input: "",
      timeoutMs: 100,
    }),
    { message: "MINT_CHILD_FAILED" },
  );
});
void test("deadline kills a stalled child and its subprocesses; next request still works", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vw-bridge-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "pid");
  const source = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000);`;
  const start = performance.now();
  await assert.rejects(run(source, 500), { message: "MINT_CHILD_FAILED" });
  assert.ok(performance.now() - start < 3000);
  const pid = Number(await readFile(pidFile, "utf8"));
  await delay(50);
  assert.throws(() => process.kill(pid, 0));
  assert.equal(await run('console.log("recovered");'), "recovered\n");
});
