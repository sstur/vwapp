import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/durable-object.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
