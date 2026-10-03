import type { NextFunction, Request, Response } from "express";
import { getRequestAuth } from "./clerkAuthConfig";
import { requireAuth, type AuthenticatedRequest } from "./requireAuth";

export function isAdminClaims(claims: unknown): boolean {
  const verifiedClaims = claims as Record<string, unknown> | undefined;
  const metadata = verifiedClaims?.metadata as Record<string, unknown> | undefined;
  const publicMetadata = verifiedClaims?.publicMetadata as Record<string, unknown> | undefined;
  return [verifiedClaims?.role, metadata?.role, publicMetadata?.role].some((value) => value === "admin");
}

export function isAdvisorClaims(claims: unknown): boolean {
  const verifiedClaims = claims as Record<string, unknown> | undefined;
  const metadata = verifiedClaims?.metadata as Record<string, unknown> | undefined;
  const publicMetadata = verifiedClaims?.publicMetadata as Record<string, unknown> | undefined;
  return [verifiedClaims?.role, metadata?.role, publicMetadata?.role].some((value) => value === "admin" || value === "advisor");
}

export async function verifiedBackendRole(
  userId: string,
  kind: "admin" | "advisor",
  secretKey: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const response = await request(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Staff role verification is unavailable.");
  const user = await response.json() as { public_metadata?: Record<string, unknown> };
  const claims = { publicMetadata: user.public_metadata };
  return kind === "admin" ? isAdminClaims(claims) : isAdvisorClaims(claims);
}

async function hasStaffRole(req: Request, kind: "admin" | "advisor") {
  if (process.env.CLERK_ROLES_FROM_BACKEND === "true") {
    const secret = process.env.CLERK_SECRET_KEY?.trim();
    if (!secret) throw new Error("Staff role verification is not configured.");
    // Identity comes exclusively from the verified session. Public metadata can
    // only be assigned through the trusted Clerk backend, never user input.
    return verifiedBackendRole((req as AuthenticatedRequest).userId, kind, secret);
  }
  const claims = getRequestAuth(req)?.sessionClaims;
  return kind === "admin" ? isAdminClaims(claims) : isAdvisorClaims(claims);
}

export function requireAdvisor(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, async () => {
    try {
      if (!await hasStaffRole(req, "advisor")) {
        res.status(403).json({ error: "Advisor access required." });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "Staff access could not be verified. Please try again." });
    }
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, async () => {
    try {
      if (!await hasStaffRole(req, "admin")) {
        res.status(403).json({ error: "Administrator access required." });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "Staff access could not be verified. Please try again." });
    }
  });
}

export function adminUserId(req: Request): string {
  return (req as AuthenticatedRequest).userId;
}