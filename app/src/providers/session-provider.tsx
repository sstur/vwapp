import {
  clearStoredAuthToken,
  getStoredAuthToken,
  setStoredAuthToken,
} from "@/auth-storage";
import { db } from "@/db";
import { orpc } from "@/rpc";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface Session {
  /** Resolving the initial auth state (guest identity + auth.me). */
  isLoading: boolean;
  loggedIn: boolean;
  /**
   * The initial auth state could not be resolved (Instant unreachable, guest
   * sign-in failed, or our server unreachable/rejecting). The saved local
   * identity is NOT touched — recovery is `retry` or, explicitly,
   * `discardLocalAuth`.
   */
  initError: string | null;
  retry: () => void;
  /** A retry kicked off from the error state is in flight. */
  retrying: boolean;
  /** Server-side logout: detach this client from the VW session. */
  signOut: () => void;
  signOutError: string | null;
  /**
   * Local-only escape hatch: discard this device's Instant guest token (a new
   * guest identity is created on the next attempt). Never called
   * automatically — identity loss is irreversible, and a transient server
   * problem must not destroy a working token.
   */
  discardLocalAuth: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const ctx = use(SessionContext);
  if (ctx === null)
    throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * App-wide auth session. Two layers:
 *  1. Instant guest auth — the device's durable identity, created on first
 *     launch. Lets the app live-query its own data and authenticates RPCs.
 *  2. The Worker's auth.me — whether this client is attached to a VW session.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const auth = db.useAuth();

  // Guest sign-in, retried via the `attempt` nonce. The in-flight ref guards
  // against double sign-ins (two guests for one device). We first try to restore
  // a refresh token kept in the keychain (survives reinstall — see
  // auth-storage.ts); only with no usable saved token do we mint a brand-new
  // guest identity.
  const [guestError, setGuestError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const signingIn = useRef(false);
  useEffect(() => {
    if (auth.isLoading || auth.user != null || signingIn.current) return;
    signingIn.current = true;
    void (async () => {
      const saved = await getStoredAuthToken();
      if (saved !== null) {
        try {
          await db.auth.signInWithToken(saved);
          return;
        } catch {
          // The saved token is stale/invalid — drop it and start fresh.
          await clearStoredAuthToken();
        }
      }
      await db.auth.signInAsGuest();
    })()
      .catch((err: unknown) => {
        setGuestError(errorMessage(err));
      })
      .finally(() => {
        signingIn.current = false;
      });
  }, [auth.isLoading, auth.user, attempt]);

  // Mirror the live identity's refresh token into the keychain so a reinstall
  // can restore it. Cheap and idempotent — writes the same value most launches.
  useEffect(() => {
    const token = auth.user?.refresh_token;
    if (token != null) void setStoredAuthToken(token);
  }, [auth.user?.refresh_token]);

  // After an explicit local discard we already KNOW this device is logged
  // out — don't block on (or surface errors from) auth.me, which may be the
  // very server that's unreachable. The flag is sticky for this launch but
  // inert once auth.me has data: every consumer also checks me.data.
  const [discarded, setDiscarded] = useState(false);

  const me = useQuery({
    ...orpc.auth.me.queryOptions(),
    enabled: auth.user != null,
    retry: 2,
  });
  const logout = useMutation(
    orpc.auth.logout.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries();
      },
    }),
  );

  // Initial resolution failed only when we have nothing to show: a guest
  // sign-in / Instant auth failure, or auth.me erroring with no cached
  // answer. A failed *background* refetch (me.isError with data) keeps the
  // last known state instead.
  const meError =
    !discarded && me.isError && me.data === undefined
      ? errorMessage(me.error)
      : null;
  const initError = guestError ?? auth.error?.message ?? meError;

  const isLoading =
    initError === null &&
    (auth.isLoading ||
      auth.user == null ||
      (!discarded && me.data === undefined && !me.isError));

  const retry = () => {
    setGuestError(null);
    setAttempt((n) => n + 1); // re-attempt guest sign-in if that step failed
    if (me.isError) void me.refetch();
  };

  const discardLocalAuth = () => {
    setDiscarded(true);
    void (async () => {
      await db.auth.signOut();
      // The keychain token belongs to the identity we're discarding — drop it so
      // a reinstall doesn't silently restore it.
      await clearStoredAuthToken();
      // The cached auth.me answer belongs to the discarded identity.
      await queryClient.resetQueries();
    })().catch((err: unknown) => {
      setGuestError(errorMessage(err));
    });
  };

  return (
    <SessionContext.Provider
      value={{
        isLoading,
        loggedIn: me.data?.loggedIn === true,
        initError,
        retry,
        retrying: me.isError && me.isFetching,
        signOut: () => {
          logout.mutate(undefined);
        },
        signOutError: logout.error === null ? null : errorMessage(logout.error),
        discardLocalAuth,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
