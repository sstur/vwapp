/**
 * Durable storage for the InstantDB guest refresh token, in the iOS keychain
 * (via expo-secure-store) rather than the app sandbox. Instant already persists
 * the token itself, but that copy lives in app storage and is wiped on
 * uninstall; the keychain copy survives a reinstall, so re-installing the app
 * restores the same guest identity (and thus the VW session it's attached to)
 * with no re-login. The Worker treats this refresh token as the client's
 * credential, so it must stay on-device — never log or transmit it.
 */
import * as SecureStore from "expo-secure-store";

const KEY = "instant-refresh-token";

const OPTIONS: SecureStore.SecureStoreOptions = {
  // Readable after the first unlock following a boot — covers app launch
  // without requiring the device to be unlocked at that very moment.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function getStoredAuthToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY, OPTIONS);
  } catch {
    return null;
  }
}

export async function setStoredAuthToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, token, OPTIONS);
  } catch {
    // Persisting is best-effort: a keychain write failure must not break auth.
  }
}

export async function clearStoredAuthToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  } catch {
    // Ignore — nothing actionable if the keychain delete fails.
  }
}
