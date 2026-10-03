import { explicitClerkProxyUrl, explicitPublishableKeyFromHost } from "./clerk-key";

declare global {
  interface Window {
    __LANDA_RUNTIME_CONFIG__?: {
      clerkPublishableKey?: string;
      clerkProxyUrl?: string;
    };
  }
}

const runtimePublishableKey =
  typeof window !== "undefined"
    ? window.__LANDA_RUNTIME_CONFIG__?.clerkPublishableKey
    : undefined;
const configuredPublishableKey = runtimePublishableKey === undefined
  ? import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
  : runtimePublishableKey;
const hostname = typeof window !== "undefined" ? window.location.hostname : "";

export const clerkAuthEnabled = Boolean(configuredPublishableKey?.trim());
export const clerkPublishableKey = clerkAuthEnabled
  ? explicitPublishableKeyFromHost(hostname, configuredPublishableKey)
  : undefined;
export const clerkProxyUrl = explicitClerkProxyUrl(
  typeof window !== "undefined" ? window.__LANDA_RUNTIME_CONFIG__?.clerkProxyUrl : undefined,
  import.meta.env.VITE_CLERK_PROXY_URL,
);