import type { Request } from "express";
import { getAuth } from "@clerk/express";
import { isPublishableKey } from "@clerk/shared/keys";

export type ClerkCredentials = {
  publishableKey: string;
  secretKey: string;
};

type ClerkEnvironment = Partial<Pick<NodeJS.ProcessEnv, "CLERK_PUBLISHABLE_KEY" | "CLERK_SECRET_KEY">>;

export function getConfiguredClerkCredentials(
  environment: ClerkEnvironment = process.env,
): ClerkCredentials | null {
  const publishableKey = environment.CLERK_PUBLISHABLE_KEY?.trim();
  const secretKey = environment.CLERK_SECRET_KEY?.trim();
  const publishableMode = publishableKey?.match(/^pk_(test|live)_/)?.[1];
  const secretMode = secretKey?.match(/^sk_(test|live)_[^\s]+$/)?.[1];

  if (
    !publishableKey ||
    !secretKey ||
    !isPublishableKey(publishableKey) ||
    !publishableMode ||
    publishableMode !== secretMode
  ) {
    return null;
  }

  return { publishableKey, secretKey };
}

export function clerkPublishableKeyForHost(_host: string, configuredKey: string): string {
  return configuredKey;
}

export function clerkAuthEnabledForRequest(req: Request): boolean {
  const appSetting = req.app?.locals?.clerkAuthEnabled;
  return typeof appSetting === "boolean"
    ? appSetting
    : getConfiguredClerkCredentials() !== null;
}

export function getRequestAuth(req: Request): ReturnType<typeof getAuth> | null {
  if (!clerkAuthEnabledForRequest(req)) return null;
  try {
    return getAuth(req);
  } catch {
    return null;
  }
}