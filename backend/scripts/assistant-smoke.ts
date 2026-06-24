/**
 * Voice-assistant smoke test: drives the deployed/local Worker's `assistant.ask`
 * end to end. Generates a spoken question with macOS `say` (so we exercise real
 * Whisper STT), sends it, prints the transcript + reply, and saves the spoken
 * reply (MeloTTS) to an .mp3 you can play.
 *
 *   API_URL=https://vwapp-api.<sub>.workers.dev/rpc \
 *     node --env-file=../.env --env-file=.dev.vars scripts/assistant-smoke.ts ["your question"]
 *
 * Needs INSTANT_APP_ID/INSTANT_ADMIN_TOKEN (.dev.vars) to mint an auth token and
 * VW_USERNAME/VW_PASSWORD/VW_PIN (root .env) to attach to the VW session
 * (compare-first: no real VW login while the shared session is alive).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { init } from "@instantdb/admin";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { contract } from "@vwapp/contract";
import schema from "@vwapp/db";

const appId = process.env.INSTANT_APP_ID;
const adminToken = process.env.INSTANT_ADMIN_TOKEN;
if (!appId || !adminToken)
  throw new Error("set INSTANT_APP_ID / INSTANT_ADMIN_TOKEN");
const username = process.env.VW_USERNAME;
const password = process.env.VW_PASSWORD;
const spin = process.env.VW_PIN;
if (!username || !password || !spin)
  throw new Error("set VW_USERNAME / VW_PASSWORD / VW_PIN in .env");

const phrase = process.argv[2] ?? "Is my car locked?";

// AUDIO_FILE=<path> sends a pre-made clip instead of synthesizing (e.g. to test
// what STT returns for silence). Otherwise synthesize with macOS `say` and
// transcode to m4a/AAC (what the app records) so the test mirrors a voice note.
let audioBase64: string;
const audioFile = process.env.AUDIO_FILE;
if (audioFile !== undefined && audioFile !== "") {
  audioBase64 = readFileSync(audioFile).toString("base64");
  console.log(`→ using audio file ${audioFile}`);
} else {
  const aiff = "/tmp/vwapp-question.aiff";
  const m4a = "/tmp/vwapp-question.m4a";
  console.log(`→ synthesizing question: "${phrase}"`);
  execFileSync("say", ["-o", aiff, phrase]);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", aiff, m4a]);
  audioBase64 = readFileSync(m4a).toString("base64");
}
console.log(`  ${String(Math.round(audioBase64.length / 1024))} KB base64`);

const db = init({ appId, adminToken, schema });
const token = await db.auth.createToken({
  email: "assistant-smoke@vwapp.invalid",
});

const url = process.env.API_URL ?? "http://localhost:8787/rpc";
const link = new RPCLink({
  url,
  headers: { authorization: `Bearer ${token}` },
});
const client: ContractRouterClient<typeof contract> = createORPCClient(link);

console.log("→ auth.login (attach to VW session)");
await client.auth.login({ username, password, spin });

console.log("→ assistant.ask");
const t0 = Date.now();
const res = await client.assistant.ask({ audioBase64 });
console.log(`  (${String(Date.now() - t0)}ms)`);
console.log("  transcript:", JSON.stringify(res.transcript));
console.log("  reply:     ", JSON.stringify(res.reply));
if (res.audioBase64 !== null) {
  const out = "/tmp/vwapp-reply.mp3";
  writeFileSync(out, Buffer.from(res.audioBase64, "base64"));
  console.log(`  reply audio → ${out} (play: afplay ${out})`);
} else {
  console.log("  reply audio: none (TTS unavailable)");
}

console.log("→ auth.logout");
await client.auth.logout();
