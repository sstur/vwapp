import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface Credentials {
  username: string;
  password: string;
}

interface LoginFlow {
  /** Credentials validated on the first screen, awaiting the S-PIN. */
  credentials: Credentials | null;
  setCredentials: (c: Credentials) => void;
  clear: () => void;
}

const LoginFlowContext = createContext<LoginFlow | null>(null);

export function useLoginFlow(): LoginFlow {
  const ctx = use(LoginFlowContext);
  if (ctx === null)
    throw new Error("useLoginFlow must be used within LoginFlowProvider");
  return ctx;
}

/**
 * Carries the VW credentials in memory across the two sign-in screens: the
 * first screen validates username + password (auth.checkCredentials), then the
 * S-PIN screen completes the login (auth.login). Kept in memory ONLY — never
 * persisted, and the S-PIN screen clears it on unmount, so abandoning the flow
 * (or finishing it) leaves no password lying around.
 */
export function LoginFlowProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentialsState] = useState<Credentials | null>(null);
  // Stable identities so the S-PIN screen's unmount-cleanup effect doesn't loop.
  const setCredentials = useCallback((c: Credentials) => {
    setCredentialsState(c);
  }, []);
  const clear = useCallback(() => {
    setCredentialsState(null);
  }, []);
  const value = useMemo<LoginFlow>(
    () => ({ credentials, setCredentials, clear }),
    [credentials, setCredentials, clear],
  );
  return (
    <LoginFlowContext.Provider value={value}>
      {children}
    </LoginFlowContext.Provider>
  );
}
