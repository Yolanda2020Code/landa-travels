import { createContext, useContext, type ReactNode } from "react";

export type AppAuthState = {
  authEnabled: boolean;
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  sessionClaims: Record<string, unknown> | null;
  user: {
    id?: string;
    imageUrl?: string;
    publicMetadata?: Record<string, unknown>;
  } | null;
  getToken: (...args: unknown[]) => Promise<string | null>;
  signOut: (...args: unknown[]) => Promise<void>;
  addListener: (listener: (state: { user?: { id?: string } | null }) => void) => () => void;
};

export const ANONYMOUS_AUTH_STATE: AppAuthState = {
  authEnabled: false,
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  sessionClaims: null,
  user: null,
  getToken: async () => null,
  signOut: async () => undefined,
  addListener: () => () => undefined,
};

const AppAuthContext = createContext<AppAuthState>(ANONYMOUS_AUTH_STATE);

export function AppAuthProvider({
  value,
  children,
}: {
  value: AppAuthState;
  children: ReactNode;
}) {
  return <AppAuthContext.Provider value={value}>{children}</AppAuthContext.Provider>;
}

export function useAppAuth(): AppAuthState {
  return useContext(AppAuthContext);
}

export function useAppClerk(): Pick<AppAuthState, "user" | "signOut" | "addListener"> {
  const { user, signOut, addListener } = useAppAuth();
  return { user, signOut, addListener };
}

export function AppAuthShow({
  when,
  children,
}: {
  when: "signed-in" | "signed-out";
  children: ReactNode;
}) {
  const { isLoaded, isSignedIn } = useAppAuth();
  if (!isLoaded) return null;
  return (when === "signed-in" ? isSignedIn : !isSignedIn) ? children : null;
}