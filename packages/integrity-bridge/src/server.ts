import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Config, IntegrityRequest, IntegrityToken } from "./protocol.ts";
import { requestSchema, tokenSchema } from "./protocol.ts";

type Mint = (request: IntegrityRequest) => Promise<IntegrityToken>;
export function createBridge(config: Config, mint: Mint) {
  let busy = false;
  let lastSuccessAt: number | null = null;
  const expected = Buffer.from("Bearer " + config.apiKey);
  function reply(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed) return;
    const raw = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(raw),
    });
    res.end(raw);
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      reply(res, 401, { error: "UNAUTHORIZED" });
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      reply(res, 200, { ok: true, service: "vw-integrity", lastSuccessAt });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/integrity") {
      reply(res, 404, { error: "NOT_FOUND" });
      return;
    }
    const length = req.headers["content-length"];
    const size = Number(length);
    if (
      !length ||
      !/^\d+$/.test(length) ||
      size < 1 ||
      size > 1024 ||
      req.headers["transfer-encoding"]
    ) {
      reply(res, 400, { error: "INVALID_REQUEST" });
      return;
    }
    // Only body receipt has a short deadline. A valid mint can take 75 seconds.
    const timer = setTimeout(() => {
      req.destroy();
    }, 5000);
    let body: IntegrityRequest;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        if (!(chunk instanceof Buffer)) throw new Error("INVALID_BODY");
        bytes += chunk.length;
        if (bytes > size) throw new Error("INVALID_BODY");
        chunks.push(chunk);
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      body = requestSchema.parse(data);
    } catch {
      reply(res, 400, { error: "INVALID_REQUEST" });
      return;
    } finally {
      clearTimeout(timer);
    }
    if (busy) {
      reply(res, 503, { error: "BRIDGE_BUSY" });
      return;
    }
    busy = true;
    const started = performance.now();
    try {
      const response = tokenSchema.parse(await mint(body));
      lastSuccessAt = Date.now();
      reply(res, 200, response);
    } catch {
      reply(res, 503, { error: "INTEGRITY_UNAVAILABLE" });
    } finally {
      busy = false;
      console.log(
        JSON.stringify({
          event: "integrity_request",
          durationMs: Math.round(performance.now() - started),
        }),
      );
    }
  }
  const server = createServer(
    { headersTimeout: 5000, requestTimeout: 10000, maxHeaderSize: 8192 },
    (req, res) => {
      void handle(req, res).catch(() => {
        reply(res, 503, { error: "INTEGRITY_UNAVAILABLE" });
      });
    },
  );
  return server;
}
