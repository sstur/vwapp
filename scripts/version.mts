// Bump the app version and commit it.
// Usage from repo root: `pnpm run version [major|minor|patch]` (default patch).
// Delegates the bump to app/scripts/bump-version.mts (which writes app/app.json
// + app/package.json), then commits just those two files.
import { execFileSync } from "node:child_process";

const part = process.argv[2] ?? "patch";

// Aborts the commit on any non-zero exit (e.g. an invalid part); exit cleanly
// with the child's code rather than dumping a Node stack trace.
try {
  // stdout piped so we can read the "x -> y" line; stderr passed through for the
  // bump script's own validation messages.
  const out = execFileSync("node", ["scripts/bump-version.mts", part], {
    cwd: "app",
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  process.stdout.write(out);

  const next = out.trim().split("->").pop()?.trim();
  execFileSync(
    "git",
    [
      "commit",
      "-qm",
      `v${next ?? ""}`,
      "app/app.json",
      "app/package.json",
    ],
    { stdio: "inherit" },
  );
  execFileSync("git", ["log", "--oneline", "-1"], { stdio: "inherit" });
} catch (err) {
  const status = (err as { status?: unknown }).status;
  process.exit(typeof status === "number" ? status : 1);
}
