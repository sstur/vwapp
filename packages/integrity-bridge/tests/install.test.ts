import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceNodeExecutable } from "../scripts/node-executable.ts";

void test("launchd uses Homebrew's stable formula link on both Mac architectures", () => {
  assert.equal(
    serviceNodeExecutable("/opt/homebrew/Cellar/node@24/24.22.0/bin/node"),
    "/opt/homebrew/opt/node@24/bin/node",
  );
  assert.equal(
    serviceNodeExecutable("/usr/local/Cellar/node/24.22.1/bin/node"),
    "/usr/local/opt/node/bin/node",
  );
});
void test("an explicit Node path wins and non-Homebrew installations remain supported", () => {
  assert.equal(
    serviceNodeExecutable("/some/version/bin/node", "/usr/local/bin/node"),
    "/usr/local/bin/node",
  );
  assert.equal(
    serviceNodeExecutable("/usr/local/bin/node"),
    "/usr/local/bin/node",
  );
  assert.throws(() => serviceNodeExecutable("/usr/local/bin/node", "node"));
  assert.throws(() => serviceNodeExecutable("node"));
});
