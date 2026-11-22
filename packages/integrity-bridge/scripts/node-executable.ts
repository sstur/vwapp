import { isAbsolute } from "node:path";

/** Homebrew's opt link survives patch upgrades; Cellar version paths do not. */
export function serviceNodeExecutable(
  current: string,
  override?: string,
): string {
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error("NODE_PATH_MUST_BE_ABSOLUTE");
    return override;
  }
  const brew = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(current);
  const prefix = brew?.[1],
    formula = brew?.[2];
  if (prefix && formula) return `${prefix}/opt/${formula}/bin/node`;
  if (!isAbsolute(current)) throw new Error("NODE_PATH_MUST_BE_ABSOLUTE");
  return current;
}
