import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import type { AppEnv } from "./env";
import { pollAllVehicles, runClimateKeepalive } from "./poll";
import { router } from "./router";
import { getDb } from "./store";

const handler = new RPCHandler(router, {
  plugins: [new CORSPlugin()],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const db = getDb(env);

    // The app authenticates with its Instant guest refresh token; verifying it
    // yields the Instant user id that all data is keyed to.
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    let userId: string | null = null;
    if (token !== null && token !== "") {
      try {
        userId = (await db.auth.verifyToken(token)).id;
      } catch {
        userId = null;
      }
    }

    const { matched, response } = await handler.handle(request, {
      prefix: "/rpc",
      context: { env, db, userId, waitUntil: ctx.waitUntil.bind(ctx) },
    });
    if (matched) return response;
    return new Response("Not found", { status: 404 });
  },

  scheduled(
    _controller: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ): void {
    const db = getDb(env);
    ctx.waitUntil(pollAllVehicles(db, env));
    // Keep user-requested climate sessions alive (restart after the car's
    // ~30-min auto-off; stop at expiry). Independent of the status poll.
    ctx.waitUntil(runClimateKeepalive(db, env));
  },
};
