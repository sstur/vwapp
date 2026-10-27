export interface AppEnv {
  INSTANT_APP_ID: string;
  INSTANT_ADMIN_TOKEN: string;
  /** base64 of 32 random bytes — AES-GCM key for sealing VW credentials. */
  CREDS_ENC_KEY: string;
  /**
   * Cloudflare Workers AI binding — runs the voice assistant's whole inference
   * chain (speech-to-text, the GLM-5.2 tool-calling LLM, and text-to-speech).
   * No API key: usage bills to the deploy account. Configured in wrangler.jsonc
   * (`ai` binding); the account must have Workers AI enabled.
   */
  AI: Ai;
  /**
   * Apple Maps Web Snapshot signing (token-based MapKit JWT, ES256). Optional:
   * when unset, the parked-location map is skipped (see `isMapsConfigured`) and
   * the rest of the app works unchanged — so a deployer needs no Apple account.
   */
  APPLE_MAPS_TEAM_ID?: string;
  APPLE_MAPS_KEY_ID?: string;
  /** The MapKit private key, PKCS#8 PEM (.p8) contents. */
  APPLE_MAPS_PRIVATE_KEY?: string;
}
