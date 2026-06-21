import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Minimal augmentation over app.json: Expo reads app.json first and passes it
 * here as `config`. We only inject the per-deployer, owner-specific bits from
 * the environment so app.json itself stays generic and nothing personal is
 * committed. These vars are NOT `EXPO_PUBLIC_` (config-time only, never bundled);
 * the Expo CLI loads app/.env into process.env when it evaluates this config.
 *
 *   EXPO_OWNER             Expo account/org that owns the project (for EAS Update)
 *   EAS_PROJECT_ID         the EAS project UUID (from `eas init`)
 *   IOS_BUNDLE_IDENTIFIER  iOS bundle id, e.g. com.yourname.vwapp
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  // Spread keys in only when present so we never assign `undefined`
  // (exactOptionalPropertyTypes). These vars are declared on ProcessEnv in
  // src/env.d.ts so dot access satisfies both TS and Expo's lint rule.
  const projectId = process.env.EAS_PROJECT_ID;
  const owner = process.env.EXPO_OWNER ?? config.owner;
  const bundleIdentifier =
    process.env.IOS_BUNDLE_IDENTIFIER ?? config.ios?.bundleIdentifier;
  return {
    ...config,
    name: config.name ?? "vwapp",
    slug: config.slug ?? "vwapp",
    ...(owner !== undefined ? { owner } : {}),
    ios: {
      ...config.ios,
      ...(bundleIdentifier !== undefined ? { bundleIdentifier } : {}),
    },
    ...(projectId !== undefined
      ? {
          updates: { url: `https://u.expo.dev/${projectId}` },
          extra: { ...config.extra, eas: { projectId } },
        }
      : {}),
  };
};
