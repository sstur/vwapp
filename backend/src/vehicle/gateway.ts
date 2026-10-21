/** One durable coordinator per attached phone. Alarms finish jobs after client disconnects. */
import { DurableObject } from "cloudflare:workers";
import { unseal } from "../crypto";
import type { AppEnv } from "../env";
import {
  endClimateSession,
  getDb,
  recordVehicleOperation,
  saveSnapshot,
  startClimateSession,
} from "../store";
import {
  credentialsSchema,
  jobResultSchema,
  toStatus,
  type JobResult,
  type PhoneJob,
} from "./android";

interface Pending {
  job: PhoneJob;
  createdAt: number;
  queuedAt?: number;
  terminal?: JobResult;
}
export class AndroidGateway extends DurableObject<AppEnv> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      const accountId = new URL(request.url).searchParams.get("accountId");
      const pending = await this.ctx.storage.get<Pending>("pending");
      const queue = (await this.ctx.storage.get<Pending[]>("queue")) ?? [];
      const own = pending?.job.accountId === accountId ? pending : undefined;
      return Response.json({
        provider: "android",
        activeRequestId: own?.job.requestId ?? null,
        activeOperation: own?.job.operation ?? null,
        startedAt: own?.createdAt ?? null,
        queueLength: queue.filter((q) => q.job.accountId === accountId).length,
        lastAlarmAt:
          (await this.ctx.storage.get<number>("lastAlarmAt")) ?? null,
      });
    }
    if (request.method === "GET") {
      const rid = path.slice("/jobs/".length);
      const done = await this.ctx.storage.get<JobResult>(`result:${rid}`);
      const pending = await this.ctx.storage.get<Pending>("pending");
      const queue = (await this.ctx.storage.get<Pending[]>("queue")) ?? [];
      return Response.json(done ?? { requestId: rid, state: "running" }, {
        status:
          done ||
          pending?.job.requestId === rid ||
          queue.some((q) => q.job.requestId === rid)
            ? 200
            : 404,
      });
    }
    // Internal binding only: the public router validates user/account/vehicle access.
    const job = await request.json<PhoneJob>();
    const response = await this.ctx.storage.transaction(async (txn) => {
      const identity = `${job.accountId}:${job.operation}:${job.vin ?? ""}:${JSON.stringify(job.params)}:${job.completion?.climate?.kind ?? ""}:${job.completion?.climate?.kind === "start" ? String(job.completion.climate.durationMin) : ""}`;
      const previous = await txn.get<string>(`identity:${job.requestId}`);
      if (previous !== undefined && previous !== identity)
        return Response.json(
          { error: "IDEMPOTENCY_CONFLICT" },
          { status: 422 },
        );
      const done = await txn.get<JobResult>(`result:${job.requestId}`);
      if (done) return Response.json(done);
      const pending = await txn.get<Pending>("pending");
      const queue = (await txn.get<Pending[]>("queue")) ?? [];
      if (previous !== undefined)
        return Response.json({ requestId: job.requestId, state: "running" });
      if (pending && (job.background || queue.length >= 3))
        return Response.json({ error: "DEVICE_BUSY" }, { status: 409 });
      if (pending) {
        queue.push({ job, createdAt: Date.now() });
        await txn.put("queue", queue);
        await txn.put(`identity:${job.requestId}`, identity);
        return Response.json({ requestId: job.requestId, state: "running" });
      }
      await txn.put(`identity:${job.requestId}`, identity);
      await txn.put("pending", {
        job,
        createdAt: Date.now(),
      } satisfies Pending);
      await txn.setAlarm(Date.now() + 100);
      return Response.json({ requestId: job.requestId, state: "running" });
    });
    if (response.ok && job.completion) {
      const pending = await this.ctx.storage.get<Pending>("pending");
      const queue = (await this.ctx.storage.get<Pending[]>("queue")) ?? [];
      const admitted =
        pending?.job.requestId === job.requestId
          ? pending
          : queue.find((q) => q.job.requestId === job.requestId);
      if (admitted)
        await recordVehicleOperation(
          getDb(this.env),
          job.requestId,
          job.completion.vehicleId,
          {
            operation: job.operation,
            state:
              pending?.job.requestId === job.requestId ? "running" : "queued",
            createdAt: admitted.createdAt,
          },
        ).catch(() => {
          console.error(
            JSON.stringify({
              event: "phone_progress_delayed",
              requestId: job.requestId,
            }),
          );
        });
    }
    return response;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.put("lastAlarmAt", Date.now());
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (!pending) return;
    const { job } = pending;
    // Persist the next wake before network IO, so even a timeout/crash is recovered.
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
    let stage = "progress";
    try {
      if (job.completion && !pending.terminal)
        await recordVehicleOperation(
          getDb(this.env),
          job.requestId,
          job.completion.vehicleId,
          {
            operation: job.operation,
            state: "running",
            createdAt: pending.createdAt,
          },
        );
      let result = pending.terminal;
      if (
        !result &&
        pending.queuedAt &&
        pending.createdAt - pending.queuedAt > 120_000
      ) {
        result = {
          requestId: job.requestId,
          state: "failed",
          error: {
            code: "REQUEST_EXPIRED",
            message:
              "Phone was busy for more than two minutes. This queued command was not sent.",
            retryable: true,
          },
        };
      }
      if (!result && Date.now() - pending.createdAt > 600_000) {
        result = {
          requestId: job.requestId,
          state: "failed",
          error: {
            code: "OUTCOME_UNKNOWN",
            message:
              "Phone did not complete within ten minutes. Check status before a new command.",
            retryable: false,
          },
        };
      }
      if (!result) {
        const base = this.env.ANDROID_BRIDGE_URL;
        const key = this.env.ANDROID_BRIDGE_KEY;
        if (!base || !key || !base.startsWith("https://"))
          throw new Error("Bridge configuration missing HTTPS URL/key");
        const headers = {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        };
        stage = "bridge_read";
        let response = await fetch(`${base}/v2/jobs/${job.requestId}`, {
          headers,
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        });
        if (response.status === 404) {
          stage = "credentials";
          const credentials = credentialsSchema.parse(
            JSON.parse(await unseal(this.env.CREDS_ENC_KEY, job.sealed)),
          );
          stage = "bridge_submit";
          response = await fetch(`${base}/v2/jobs`, {
            method: "POST",
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
              requestId: job.requestId,
              operation: job.operation,
              vin: job.vin,
              params: job.params,
              credentials,
            }),
          });
        }
        if (
          response.status === 409 ||
          response.status === 400 ||
          response.status === 403
        ) {
          const failure = await response.json<{
            error: string;
            message?: string;
          }>();
          if (failure.error === "DEVICE_BUSY") return;
          result = {
            requestId: job.requestId,
            state: "failed",
            error: {
              code: failure.error,
              message: failure.message ?? "Phone rejected this request",
              retryable: false,
            },
          };
        } else {
          if (!response.ok)
            throw new Error(`Bridge HTTP ${String(response.status)}`);
          stage = "bridge_response";
          result = jobResultSchema.parse(await response.json());
        }
        if (result.state === "running") return;
        pending.terminal = result;
        await this.ctx.storage.put("pending", pending); // Finalization never reissues the phone command.
      }
      stage = "finalization";
      if (result.state === "succeeded" && job.completion) {
        const db = getDb(this.env);
        if (job.operation === "status")
          await saveSnapshot(
            db,
            job.completion.vehicleId,
            toStatus(result.result),
            { snapshotId: job.requestId },
          );
        const climate = job.completion.climate;
        if (climate?.kind === "start")
          await startClimateSession(db, job.completion.vehicleId, {
            sessionId: job.requestId,
            tempF: climate.tempF,
            expiresAt: climate.expiresAt,
          });
        else if (climate?.kind === "stop")
          await endClimateSession(db, job.completion.vehicleId, climate.reason);
      }
      if (job.completion)
        await recordVehicleOperation(
          getDb(this.env),
          job.requestId,
          job.completion.vehicleId,
          {
            operation: job.operation,
            state: result.state,
            createdAt: pending.createdAt,
            finishedAt: Date.now(),
            ...(result.error
              ? { errorCode: result.error.code, message: result.error.message }
              : {}),
          },
        );
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(`result:${job.requestId}`, result);
        await txn.delete("pending");
        await txn.deleteAlarm();
        const queue = (await txn.get<Pending[]>("queue")) ?? [];
        const next = queue.shift();
        if (next) {
          await txn.put("pending", {
            ...next,
            queuedAt: next.createdAt,
            createdAt: Date.now(),
          });
          await txn.setAlarm(Date.now() + 100);
        }
        await txn.put("queue", queue);
      });
      console.log(
        JSON.stringify({
          event: "phone_job_finished",
          requestId: job.requestId,
          operation: job.operation,
          state: result.state,
          errorCode: result.error?.code,
          durationMs: Date.now() - pending.createdAt,
        }),
      );
    } catch (error) {
      // No body/credentials/UI contents in logs. Alarm remains armed for recovery.
      console.error(
        JSON.stringify({
          event: "phone_job_retry",
          requestId: job.requestId,
          stage,
          transportError:
            stage === "bridge_read" && error instanceof Error
              ? error.message
                  .replaceAll(
                    this.env.ANDROID_BRIDGE_KEY ?? "[unset]",
                    "[redacted]",
                  )
                  .replaceAll(
                    this.env.ANDROID_BRIDGE_URL ?? "[unset]",
                    "[bridge]",
                  )
                  .slice(0, 160)
              : undefined,
          errorType: error instanceof Error ? error.name : "Error",
          errorFrame:
            error instanceof Error
              ? error.stack?.split("\n")[1]?.trim()
              : undefined,
        }),
      );
    }
  }
}
