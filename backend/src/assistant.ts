/**
 * Voice assistant pipeline — all inference on Cloudflare Workers AI (one `env.AI`
 * binding, no external keys):
 *
 *   1. STT   — Whisper transcribes the recorded voice note.
 *   2. LLM   — a tool-calling loop (LLM_MODEL); its tools are the same vehicle
 *              status reads and S-PIN-gated commands the oRPC procedures expose
 *              (reused verbatim via the passed-in router caller — no duplicated
 *              VW/spin/climate-session orchestration).
 *   3. TTS   — TTS_MODEL speaks the short reply.
 *
 * The exact Workers AI request/response shapes here are typed against the
 * generated worker-configuration.d.ts (ChatCompletions*, whisper, melotts). The
 * one exception is the LLM model id (typed as a plain string), which routes
 * through the binding's untyped-model overload — see `callLlm`.
 */
import type {
  ActivityEventDTO,
  InboxMessageDTO,
  StatusDTO,
} from "@vwapp/contract";
import type { AppEnv } from "./env";
import { reverseGeocode } from "./maps";
import {
  getActiveClimateSession,
  getLatestSnapshot,
  type ClimateSession,
  type Db,
} from "./store";

/** The subset of the oRPC router the assistant's tools invoke (structural — the
 *  real `createRouterClient(router)` result satisfies this). Reusing the
 *  procedures keeps all VW/S-PIN/climate-session logic in one place. */
export interface VehicleCaller {
  vehicle: {
    refresh(input: { uuid?: string }): Promise<StatusDTO>;
    command(input: {
      uuid?: string;
      action: "lock" | "unlock";
    }): Promise<{ ok: true; locked: boolean | null }>;
    climateStart(input: {
      uuid?: string;
      tempF: number;
      durationMin: number;
    }): Promise<{ ok: true }>;
    climateStop(input: { uuid?: string }): Promise<{ ok: true }>;
    climateInfo(input: {
      uuid?: string;
    }): Promise<{ targetTempF: number | null }>;
    chargeStart(input: { uuid?: string }): Promise<{ ok: true }>;
    chargeStop(input: { uuid?: string }): Promise<{ ok: true }>;
    setChargeLimit(input: {
      uuid?: string;
      targetSoc: number;
    }): Promise<{ ok: true }>;
    activity(input: { uuid?: string }): Promise<{ events: ActivityEventDTO[] }>;
    messages(input: {
      uuid?: string;
    }): Promise<{ messages: InboxMessageDTO[] }>;
  };
}

interface AssistantVehicle {
  id: string;
  uuid: string;
  nickname: string | null;
  model: string | null;
}

// --- Chat-LLM shapes (OpenAI-compatible; mirror the global ChatCompletions*
//     types, narrowed to what we use so the call stays decoupled from the
//     untyped model id). ----------------------------------------------------
interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}
interface LlmTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
interface LlmInput {
  messages: LlmMessage[];
  tools: LlmTool[];
  tool_choice: "auto";
  max_completion_tokens: number;
  reasoning_effort: "low" | "medium" | "high";
}
interface LlmOutput {
  choices: { message: LlmMessage }[];
}

// LLM for the tool loop. gpt-oss-120b (MoE, ~5B active) won an on-Cloudflare A/B
// vs GLM-4.7-Flash: per-call LLM latency ~0.4-1.1s and *consistent* (GLM had
// 6-16s outliers), better instruction-following (kept numbers as digits, which
// GLM relapsed on), and smarter tool judgment. Uses reasoning_effort "low" to
// stay snappy. Typed as `string` so the binding always uses its untyped-model
// overload (uniform whether or not the id is in the generated AiModels). To
// compare alternatives, swap to "@cf/zai-org/glm-4.7-flash" or
// "@cf/meta/llama-3.3-70b-instruct-fp8-fast".
const LLM_MODEL = "@cf/openai/gpt-oss-120b" as string;
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
// Deepgram Aura-2 (English): much clearer than MeloTTS. WAV output keeps the app
// unchanged (it already plays data:audio/wav). Change TTS_VOICE to any speaker
// in the Aura-2-en `speaker` enum (e.g. apollo, atlas, hera, asteria).
const TTS_MODEL = "@cf/deepgram/aura-2-en";
const TTS_VOICE = "athena";

/**
 * Call the chat LLM via the binding. The model id is typed as `string`, so this
 * routes through the binding's untyped-model overload; the request/response are
 * the unified OpenAI-style ChatCompletions shapes, asserted here.
 */
async function callLlm(env: AppEnv, input: LlmInput): Promise<LlmOutput> {
  const out = await env.AI.run(
    LLM_MODEL,
    input as unknown as Record<string, unknown>,
  );
  return out as unknown as LlmOutput;
}

const kmToMiles = (km: number): number => Math.round(km / 1.609344);

/** Speakable "x minutes/hours/days ago" from an epoch-ms timestamp. */
function relativeTime(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${String(min)} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${String(hr)} hour${hr === 1 ? "" : "s"} ago`;
  const d = Math.round(hr / 24);
  return `${String(d)} day${d === 1 ? "" : "s"} ago`;
}

/** Base64-encode bytes without Node's Buffer (not typed in the Worker lib). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Coerce a TTS binding result to a base64 audio string. The generated typings
 * say Aura returns a string, but at runtime Workers AI TTS can hand back bytes,
 * a stream, a Response, or a `{ audio }` object — handle them all.
 */
async function ttsToBase64(out: unknown): Promise<string | null> {
  if (out === null || out === undefined) return null;
  if (typeof out === "string") return out;
  if (out instanceof Uint8Array) return bytesToBase64(out);
  if (out instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(out));
  if (out instanceof ReadableStream)
    return bytesToBase64(new Uint8Array(await new Response(out).arrayBuffer()));
  if (out instanceof Response)
    return bytesToBase64(new Uint8Array(await out.arrayBuffer()));
  if (typeof out === "object" && "audio" in out) {
    const a = (out as { audio?: unknown }).audio;
    if (typeof a === "string") return a;
  }
  return null;
}

/** The status fields the summary reads — satisfied by both a stored snapshot
 *  record and a live StatusDTO (the refresh result). */
interface StatusLike {
  locked?: boolean | null;
  soc?: number | null;
  rangeKm?: number | null;
  pluggedIn?: boolean | null;
  plugLocked?: boolean | null;
  chargeState?: string | null;
  chargePowerKw?: number | null;
  minutesToFull?: number | null;
  targetSoc?: number | null;
  odometerKm?: number | null;
  openDoors?: string[] | null;
  openWindows?: string[] | null;
  unlockedDoors?: string[] | null;
  parkedAt?: number | null;
  /** capturedAt is VW's time; createdAt is our snapshot's row time (fallback). */
  capturedAt?: number | null;
  createdAt?: number | null;
}

/** Compact, speakable status summary from the latest stored snapshot. */
function summarizeStatus(s: StatusLike | undefined): string {
  if (s === undefined)
    return "No status has been recorded for the vehicle yet.";
  const parts: string[] = [];
  if (s.locked !== null && s.locked !== undefined)
    parts.push(s.locked ? "vehicle locked" : "vehicle unlocked");
  if (s.soc !== null && s.soc !== undefined)
    parts.push(`battery ${String(s.soc)}%`);
  if (s.rangeKm !== null && s.rangeKm !== undefined)
    parts.push(`range ${String(kmToMiles(s.rangeKm))} miles`);
  // Derive charging explicitly rather than passing VW's raw chargeState string
  // (which the model misreads): charging iff chargeState STARTS WITH "charging".
  // VW's idle, target-reached states can END in "Charging" (e.g.
  // "chargePurposeReachedAndNotConservationCharging"), so a substring match
  // wrongly flags them — the same rule the app uses (activity-events /
  // charge-control).
  const charging = s.chargeState?.toLowerCase().startsWith("charging") ?? false;
  if (s.pluggedIn === true) {
    if (charging) {
      parts.push(
        s.chargePowerKw !== null &&
          s.chargePowerKw !== undefined &&
          s.chargePowerKw > 0
          ? `charging at ${String(s.chargePowerKw)} kW`
          : "charging",
      );
      if (
        s.minutesToFull !== null &&
        s.minutesToFull !== undefined &&
        s.minutesToFull > 0
      )
        parts.push(`${String(s.minutesToFull)} minutes to full`);
    } else {
      parts.push("plugged in but not charging");
    }
    if (s.plugLocked !== null && s.plugLocked !== undefined)
      parts.push(`plug ${s.plugLocked ? "locked" : "unlocked"}`);
  } else if (s.pluggedIn === false) {
    parts.push("not plugged in");
  }
  if (s.targetSoc !== null && s.targetSoc !== undefined)
    parts.push(`charge limit ${String(s.targetSoc)}%`);
  if (s.odometerKm !== null && s.odometerKm !== undefined)
    parts.push(`odometer ${String(kmToMiles(s.odometerKm))} miles`);
  // "open" = physically ajar (doorStatus OPEN), kept distinct from lock state so
  // the model never calls an unlocked-but-closed door "open". Always emit a
  // positive closed statement when nothing is ajar.
  const openClosures = [...(s.openDoors ?? []), ...(s.openWindows ?? [])];
  parts.push(
    openClosures.length > 0
      ? `physically open (ajar): ${openClosures.join(", ")}`
      : "all doors and windows are closed",
  );
  // Per-door unlocked detail only when the vehicle is otherwise locked (a
  // partial unlock); when the whole vehicle is unlocked it's redundant noise.
  const unlockedDoors = s.unlockedDoors ?? [];
  if (s.locked === true && unlockedDoors.length > 0)
    parts.push(`unlocked but closed: ${unlockedDoors.join(", ")}`);
  if (s.parkedAt !== null && s.parkedAt !== undefined)
    parts.push(`parked ${relativeTime(s.parkedAt)}`);
  const updated = s.capturedAt ?? s.createdAt;
  if (updated !== null && updated !== undefined)
    parts.push(`last reported ${relativeTime(updated)}`);
  return parts.length > 0 ? parts.join("; ") : "No status details available.";
}

/** Climate run-state for the prompt, from our managed session (what the app's
 *  climate card reflects). Without this the model guesses whether climate is on. */
function describeClimate(session: ClimateSession | null): string {
  if (session === null) return "Climate is off.";
  if (session.pausedAt !== null)
    return `Climate is paused (car in use), target ${String(session.tempF)}°F — it resumes when parked.`;
  const remainMin = Math.max(
    0,
    Math.round((session.expiresAt - Date.now()) / 60_000),
  );
  return `Climate is ON now, target ${String(session.tempF)}°F, about ${String(remainMin)} minute${remainMin === 1 ? "" : "s"} remaining.`;
}

interface ParkedLocation {
  lat: number;
  lng: number;
  at: number | null;
}

/** The tools the LLM may call, paired with their executors. */
function buildTools(toolCtx: {
  env: AppEnv;
  caller: VehicleCaller;
  vehicle: AssistantVehicle;
  parked: ParkedLocation | null;
  waitUntil: (promise: Promise<unknown>) => void;
}): {
  defs: LlmTool[];
  exec: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
  const { env, caller, vehicle, parked, waitUntil } = toolCtx;
  const uuid = vehicle.uuid;

  // Mutative commands take VW 6-20s to confirm. Rather than make the user wait
  // for an audible reply, we KICK THEM OFF and return immediately — the spoken
  // reply just says the request was sent. The command must run via waitUntil or
  // the Worker would kill the in-flight VW request the moment we respond; errors
  // can't reach the user now, so log them (the dashboard reflects the real state
  // via the cron + snapshot the command still writes when it finishes).
  const fireAndForget = (label: string, op: Promise<unknown>): void => {
    waitUntil(
      op.catch((err: unknown) => {
        console.error(`[assistant] background ${label} failed`, err);
      }),
    );
  };
  const noArgs = {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  };
  const fn = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
  ): LlmTool => ({
    type: "function",
    function: { name, description, parameters },
  });

  const defs: LlmTool[] = [
    // No get_status tool: the current status is prefetched into the prompt, so
    // read questions are answered in one call. `refresh` covers "get the latest".
    fn("lock", "Lock the vehicle's doors.", noArgs),
    fn("unlock", "Unlock the vehicle's doors.", noArgs),
    fn(
      "start_climate",
      "Turn on climate (pre-conditioning) at a target cabin temperature for a duration.",
      {
        type: "object",
        properties: {
          tempF: {
            type: "integer",
            minimum: 60,
            maximum: 85,
            description: "Target cabin temperature in °F (60–85).",
          },
          durationMin: {
            type: "integer",
            minimum: 5,
            maximum: 1440,
            description: "How long to keep climate on, in minutes (5–1440).",
          },
        },
        required: ["tempF", "durationMin"],
        additionalProperties: false,
      },
    ),
    fn("stop_climate", "Turn climate off now.", noArgs),
    fn("get_climate", "Get the current target cabin temperature (°F).", noArgs),
    fn(
      "start_charge",
      "Start charging now (the car must be plugged in).",
      noArgs,
    ),
    fn("stop_charge", "Stop charging now.", noArgs),
    fn("set_charge_limit", "Set the charging limit (target battery %).", {
      type: "object",
      properties: {
        targetSoc: {
          type: "integer",
          enum: [50, 60, 70, 80, 90, 100],
          description: "Target charge limit %, in steps of 10 (50–100).",
        },
      },
      required: ["targetSoc"],
      additionalProperties: false,
    }),
    fn(
      "refresh",
      "Wake the car to fetch its latest telemetry, then report status.",
      noArgs,
    ),
    fn(
      "get_parked_location",
      "Get the street address where the car is currently parked.",
      noArgs,
    ),
    fn(
      "get_activity",
      "Get the car's recent activity log (commands, trips, alerts).",
      noArgs,
    ),
    fn(
      "get_messages",
      "Get the car's message-center inbox (notices from VW).",
      noArgs,
    ),
  ];

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const exec = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    switch (name) {
      case "lock": {
        fireAndForget("lock", caller.vehicle.command({ uuid, action: "lock" }));
        return "Lock request sent to the car.";
      }
      case "unlock": {
        fireAndForget(
          "unlock",
          caller.vehicle.command({ uuid, action: "unlock" }),
        );
        return "Unlock request sent to the car.";
      }
      case "start_climate": {
        const tempF = num(args["tempF"]);
        const durationMin = num(args["durationMin"]);
        if (tempF === null || durationMin === null)
          return "Missing temperature or duration.";
        fireAndForget(
          "start_climate",
          caller.vehicle.climateStart({ uuid, tempF, durationMin }),
        );
        return `Climate start request sent (target ${String(tempF)}°F for ${String(durationMin)} minutes).`;
      }
      case "stop_climate":
        fireAndForget("stop_climate", caller.vehicle.climateStop({ uuid }));
        return "Climate stop request sent.";
      case "get_climate": {
        const { targetTempF } = await caller.vehicle.climateInfo({ uuid });
        return targetTempF === null
          ? "The target temperature isn't available."
          : `Target temperature is ${String(targetTempF)}°F.`;
      }
      case "start_charge":
        fireAndForget("start_charge", caller.vehicle.chargeStart({ uuid }));
        return "Charge start request sent.";
      case "stop_charge":
        fireAndForget("stop_charge", caller.vehicle.chargeStop({ uuid }));
        return "Charge stop request sent.";
      case "set_charge_limit": {
        const targetSoc = num(args["targetSoc"]);
        if (targetSoc === null) return "Missing target charge limit.";
        fireAndForget(
          "set_charge_limit",
          caller.vehicle.setChargeLimit({ uuid, targetSoc }),
        );
        return `Charge limit change to ${String(targetSoc)}% sent.`;
      }
      case "refresh": {
        return summarizeStatus(await caller.vehicle.refresh({ uuid }));
      }
      case "get_parked_location": {
        if (parked === null)
          return "I don't have a parked location for the car yet.";
        const address = await reverseGeocode(env, parked.lat, parked.lng);
        if (address !== null) return `The car is parked at ${address}.`;
        return parked.at !== null
          ? `The car parked ${relativeTime(parked.at)}, but I couldn't look up the address.`
          : "I have the parked coordinates but couldn't look up the address.";
      }
      case "get_activity": {
        const { events } = await caller.vehicle.activity({ uuid });
        if (events.length === 0) return "No recent activity.";
        const top = events
          .slice(0, 3)
          .map(
            (e) =>
              `${e.title}${e.at !== null ? ` (${relativeTime(e.at)})` : ""}`,
          );
        return `Recent activity: ${top.join("; ")}.`;
      }
      case "get_messages": {
        const { messages } = await caller.vehicle.messages({ uuid });
        if (messages.length === 0) return "You have no messages.";
        const unread = messages.filter((m) => !m.read).length;
        const latest = messages[0];
        const latestTitle =
          latest !== undefined ? ` Latest: ${latest.title}.` : "";
        return `You have ${String(unread)} unread message${unread === 1 ? "" : "s"}.${latestTitle}`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  };

  return { defs, exec };
}

function systemPrompt(): string {
  return [
    "You are a hands-free voice assistant for the user's car.",
    "Your reply is read aloud, so be extremely concise: one short sentence, no markdown, no lists.",
    "You are given the current vehicle status — lock state, open doors/windows, battery, range, odometer, charging/plug state, charge limit, WHETHER CLIMATE IS RUNNING, when it last parked, and when it last reported. Answer status questions (e.g. 'are my doors locked?', 'how many miles on the odometer?', 'how much range?') directly from it WITHOUT calling a tool. In particular, whether climate is on/off is stated in the status — trust it; don't guess. A door that is 'unlocked' (closed but not locked) is NOT 'open' (physically ajar) — never describe an unlocked door as open; report a door as open only if the status lists it under 'physically open'.",
    "Tools — actions: lock, unlock, start_climate, stop_climate, start_charge, stop_charge, set_charge_limit. Reads: get_parked_location (parked street address), get_activity, get_messages, get_climate (configured target temp), refresh (wake the car for the very latest). Never ask which vehicle — there is only one.",
    "CRITICAL: An action only happens when you CALL ITS TOOL. To lock, unlock, start/stop climate, or start/stop/limit charging you MUST emit the tool call — never answer with words alone. When the user asks for an action, your turn's first move is the tool call, not a sentence.",
    'Action tools only QUEUE the request with the car: they return as soon as it has been SENT, and the car takes a few seconds to actually carry it out. After calling one, tell the user you have SENT or STARTED the request — do NOT claim it is already done, locked, unlocked, on, off, complete, or confirmed. Good: "I\'ve sent the request to lock your doors." / "Starting climate at 70 degrees." Bad: "Done — doors locked." Read/status questions are different — answer those directly.',
    'Your reply is spoken by text-to-speech. Keep NUMBERS as digits — never spell them out (write "70 degrees" not "seventy degrees", "80 percent" not "eighty percent", an odometer of "47,235 miles" not "forty-seven thousand..."). But replace SYMBOLS and abbreviations with words: temperatures as a number then "degrees" (never "70°F" or "70F"), percentages as a number then "percent" (never "80%"), distances in "miles". No markdown. Refer to it only as "your vehicle" or "your car" — never mention its make or model.',
    "Don't ask clarifying questions for unambiguous requests. If a request can't be done, say so briefly.",
  ].join(" ");
}

export interface AssistantResult {
  transcript: string;
  reply: string;
  audioBase64: string | null;
}

/** Run the full STT → LLM tool loop → TTS pipeline for one voice note. */
export async function runAssistant(args: {
  env: AppEnv;
  db: Db;
  caller: VehicleCaller;
  vehicle: AssistantVehicle;
  audioBase64: string;
  /** Keeps fire-and-forget vehicle commands alive past the HTTP response. */
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<AssistantResult> {
  const { env, db, caller, vehicle, audioBase64, waitUntil } = args;
  const t0 = Date.now();
  // Per-stage timing so we optimize the real bottleneck (logged at the end).
  let llmMs = 0;
  let llmCalls = 0;
  let toolMs = 0;

  // 1. Speech-to-text (in parallel with the prefetch reads below). vad_filter
  // drops silence so an empty/silent recording transcribes to "" (caught below)
  // instead of Whisper hallucinating "Thank you." → the LLM saying "you're welcome".
  const [stt, snapshot, climate] = await Promise.all([
    env.AI.run(STT_MODEL, { audio: audioBase64, vad_filter: true }),
    getLatestSnapshot(db, vehicle.id),
    getActiveClimateSession(db, vehicle.id),
  ]);
  const sttMs = Date.now() - t0;
  const transcript = stt.text.trim();
  console.log(
    `[assistant] stt: audioB64Len=${String(audioBase64.length)} transcript=${JSON.stringify(transcript)}`,
  );
  if (transcript === "")
    return { transcript: "", reply: "I didn't catch that.", audioBase64: null };

  const parked: ParkedLocation | null =
    snapshot?.parkedLat != null && snapshot.parkedLng != null
      ? {
          lat: snapshot.parkedLat,
          lng: snapshot.parkedLng,
          at: snapshot.parkedAt ?? null,
        }
      : null;

  // 2. LLM tool loop. Prefetch the latest status + climate state into context so
  // read questions ("is it locked?", "is climate on?") are answered in ONE call.
  const { defs, exec } = buildTools({
    env,
    caller,
    vehicle,
    parked,
    waitUntil,
  });
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt() },
    {
      role: "system",
      content: `Current vehicle status (cached — may be slightly stale): ${summarizeStatus(snapshot)}. ${describeClimate(climate)}`,
    },
    { role: "user", content: transcript },
  ];

  let reply = "";
  for (let turn = 0; turn < 6; turn++) {
    const tLlm = Date.now();
    const out = await callLlm(env, {
      messages,
      tools: defs,
      tool_choice: "auto",
      max_completion_tokens: 512,
      reasoning_effort: "low",
    });
    llmMs += Date.now() - tLlm;
    llmCalls += 1;
    const msg = out.choices[0]?.message;
    if (msg === undefined) break;

    // We only define function tools, so any tool calls are function calls.
    const toolCalls = msg.tool_calls ?? [];
    // Echo the assistant turn back (the model needs to see its own tool_calls).
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      reply = (msg.content ?? "").trim();
      break;
    }

    for (const tc of toolCalls) {
      let result: string;
      const tTool = Date.now();
      try {
        const parsed = JSON.parse(tc.function.arguments || "{}") as unknown;
        const argObj =
          typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
        result = await exec(tc.function.name, argObj);
      } catch (err) {
        result =
          err instanceof Error ? `Error: ${err.message}` : "The action failed.";
      }
      toolMs += Date.now() - tTool;
      console.log(`[assistant] tool ${tc.function.name} -> ${result}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  if (reply === "")
    reply = "Sorry, I couldn't complete that. Please try again.";

  // 3. Text-to-speech (best effort — null audio falls back to on-screen text).
  // Aura returns the audio as a base64 string; WAV so the app plays it as-is.
  const tTts = Date.now();
  let replyAudio: string | null = null;
  try {
    const out: unknown = await env.AI.run(TTS_MODEL, {
      text: reply,
      speaker: TTS_VOICE,
      encoding: "linear16",
      container: "wav",
    });
    console.log(
      `[assistant] tts out: ${typeof out}${out instanceof ReadableStream ? " stream" : out instanceof Uint8Array ? " u8" : out instanceof ArrayBuffer ? " ab" : out instanceof Response ? " response" : typeof out === "object" && out !== null ? ` keys=${Object.keys(out).join(",")}` : ""}`,
    );
    replyAudio = await ttsToBase64(out);
  } catch (err) {
    console.error("[assistant] TTS failed; returning text only", err);
  }
  const ttsMs = Date.now() - tTts;

  console.log(
    `[assistant] timings ms: total=${String(Date.now() - t0)} stt=${String(sttMs)} llm=${String(llmMs)}(${String(llmCalls)} calls) tools=${String(toolMs)} tts=${String(ttsMs)}`,
  );

  return { transcript, reply, audioBase64: replyAudio };
}
