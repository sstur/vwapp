import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log("Skipping macOS-only bridge checks on this platform.");
} else {
  const manifest = "packages/integrity-bridge/Cargo.toml";
  const checks = [
    ["fmt", "--manifest-path", manifest, "--check"],
    [
      "clippy",
      "--locked",
      "--manifest-path",
      manifest,
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
    ["test", "--locked", "--manifest-path", manifest],
  ];
  for (const args of checks) {
    const result = spawnSync("cargo", args, { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      console.error("Rust checks failed; install Rust and put Cargo on PATH.");
      process.exit(result.status ?? 1);
    }
  }
}
