import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { SerialQueue } from "./serial";
import { getAccountById, getDb, saveCarnetToken, updateTokens } from "./store";
import { renewAccount, VwLoginBlockedError } from "./tokens";
import {
  jwtExpiryMs,
  VwAuthError,
  VwCommandError,
  vwMintSpinSession,
  type VwTokens,
} from "./vw/client";

interface Renewal {
  accountId: string;
  previousAccessToken: string;
  rejected: boolean;
}
interface PendingSave {
  previousAccessToken: string;
  tokens: VwTokens;
}

/** Private Worker binding, one instance per VW account; no public HTTP route. */
export class AuthSession extends DurableObject<AppEnv> {
  private queue = new SerialQueue();

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/carnet") {
      const input = await request.json<{
        accountId: string;
        uuid: string;
        spin: string;
        force: boolean;
      }>();
      return this.queue.run(async () => {
        const db = getDb(this.env);
        const account = await getAccountById(db, input.accountId);
        if (!account)
          return Response.json(
            { error: "Missing VW account" },
            { status: 401 },
          );
        const cached = account.carnetTokens[input.uuid];
        if (!input.force && cached && cached.expiresAt > Date.now() + 180_000)
          return Response.json(cached);
        try {
          const token = await vwMintSpinSession(
            account.tokens,
            input.uuid,
            input.spin,
          );
          const entry = {
            token,
            expiresAt: jwtExpiryMs(token) ?? Date.now() + 25 * 60_000,
          };
          await saveCarnetToken(db, account, input.uuid, entry);
          return Response.json(entry);
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof VwCommandError
                  ? error.message
                  : "VW S-PIN session is unavailable.",
            },
            { status: error instanceof VwAuthError ? 401 : 503 },
          );
        }
      });
    }
    const input = await request.json<Renewal>();
    return this.queue.run(async () => {
      const db = getDb(this.env);
      const account = await getAccountById(db, input.accountId);
      if (account === null)
        return Response.json({ error: "auth" }, { status: 401 });
      // If InstantDB failed after VW rotated a token, finish that save before
      // attempting another exchange with the now-obsolete refresh token.
      const pending = await this.ctx.storage.get<PendingSave>("pending");
      if (pending?.previousAccessToken === account.tokens.accessToken) {
        await updateTokens(db, account.id, pending.tokens);
        account.tokens = pending.tokens;
      }
      if (pending !== undefined) await this.ctx.storage.delete("pending");
      if (
        account.tokens.expiresAt > Date.now() + 60_000 &&
        (!input.rejected ||
          account.tokens.accessToken !== input.previousAccessToken)
      ) {
        return Response.json(account.tokens);
      }
      const retryAt = (await this.ctx.storage.get<number>("retryAt")) ?? 0;
      if (retryAt > Date.now())
        return Response.json({ error: "unavailable" }, { status: 503 });
      try {
        const tokens = await renewAccount(
          db,
          this.env,
          account,
          input.rejected,
        );
        await this.ctx.storage.put("pending", {
          previousAccessToken: account.tokens.accessToken,
          tokens,
        });
        await updateTokens(db, account.id, tokens);
        await this.ctx.storage.delete(["pending", "retryAt"]);
        return Response.json(tokens);
      } catch (error) {
        await this.ctx.storage.put("retryAt", Date.now() + 60_000);
        const code =
          error instanceof VwLoginBlockedError
            ? "blocked"
            : error instanceof VwAuthError
              ? "auth"
              : "unavailable";
        console.error(
          `[auth] renewal failed: ${code} (${error instanceof Error ? error.name : "unknown"})`,
        );
        return Response.json(
          { error: code },
          { status: code === "auth" ? 401 : 503 },
        );
      }
    });
  }
}
