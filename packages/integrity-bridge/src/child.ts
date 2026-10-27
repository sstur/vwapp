import { spawn } from "node:child_process";

/** Kill the whole process group, including any ADB subprocess, on a deadline. */
export function runChild(options: {
  executable: string;
  args: string[];
  input: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    function stop() {
      failed = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // It may already have exited. close/error still settles the promise.
          child.kill("SIGKILL");
        }
      }
    }
    const timer = setTimeout(stop, options.timeoutMs);
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 65536) stop();
      else chunks.push(data);
    });
    child.stdin.on("error", stop);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("MINT_CHILD_FAILED"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error("MINT_CHILD_FAILED"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(options.input);
  });
}
