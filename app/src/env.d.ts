/**
 * EXPO_PUBLIC_* vars inlined by babel-preset-expo, plus the config-time-only
 * vars read by app.config.ts. Declared explicitly so dot access typechecks
 * under noPropertyAccessFromIndexSignature (Expo's lint rule forbids the
 * bracket-access workaround).
 */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      EXPO_PUBLIC_API_URL?: string;
      EXPO_PUBLIC_INSTANT_APP_ID?: string;
      // Read in app.config.ts only (not bundled into the client).
      EXPO_OWNER?: string;
      EAS_PROJECT_ID?: string;
      IOS_BUNDLE_IDENTIFIER?: string;
    }
  }
}

export {};
