import { DurableObject } from "cloudflare:workers";

/** Retain old job data for rollback; never resume retired UI automation. */
export class AndroidGateway extends DurableObject {
  override fetch(): Promise<Response> {
    return Promise.resolve(
      new Response("UI automation has been retired", { status: 410 }),
    );
  }
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}
