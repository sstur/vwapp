import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).refine(isAbsolute);
export const configSchema = z.strictObject({
  serial: z.string().min(1),
  adb: absolutePath,
  apiKey: z
    .string()
    .min(32)
    .regex(/^[\x21-\x7e]+$/),
  host: z.string().min(1),
  port: z.int().min(1).max(65535),
  package: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]+$/),
  versionCode: z.string().regex(/^\d+$/),
  activity: z.string().regex(/^[A-Za-z][A-Za-z0-9_.$]+$/),
  fridaServer: absolutePath,
});
export type Config = z.infer<typeof configSchema>;
export const requestSchema = z.strictObject({
  requestHash: z.string().regex(/^[A-Za-z0-9_-]{43}=$/),
});
export type IntegrityRequest = z.infer<typeof requestSchema>;
export const tokenSchema = z.strictObject({
  token: z.string().min(101).max(19999),
});
export type IntegrityToken = z.infer<typeof tokenSchema>;
export const pollSchema = z.union([
  z.strictObject({ pending: z.literal(true) }),
  z.strictObject({ ready: z.literal(true) }),
  tokenSchema,
  z.strictObject({ error: z.string() }),
]);
export const startedSchema = z.strictObject({ started: z.literal(true) });

export async function readConfig(path: string): Promise<Config> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return configSchema.parse(data);
  } catch {
    // Zod diagnostics may include input values. Never log private config.
    throw new Error("INVALID_CONFIG");
  }
}
