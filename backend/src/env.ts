export interface AppEnv {
  INSTANT_APP_ID: string;
  INSTANT_ADMIN_TOKEN: string;
  /** base64 of 32 random bytes — AES-GCM key for sealing VW credentials. */
  CREDS_ENC_KEY: string;
  /** Apple Maps Web Snapshot signing (token-based MapKit JWT, ES256). */
  APPLE_MAPS_TEAM_ID: string;
  APPLE_MAPS_KEY_ID: string;
  /** The MapKit private key, PKCS#8 PEM (.p8) contents. */
  APPLE_MAPS_PRIVATE_KEY: string;
}
