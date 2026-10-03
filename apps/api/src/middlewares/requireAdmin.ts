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

export function requireAdvisor(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!isAdvisorClaims(getRequestAuth(req)?.sessionClaims)) {
      res.status(403).json({ error: "Advisor access required." });
      return;
    }
    next();
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!isAdminClaims(getRequestAuth(req)?.sessionClaims)) {
      res.status(403).json({ error: "Administrator access required." });
      return;
    }
    next();
  });
}

export function adminUserId(req: Request): string {
  return (req as AuthenticatedRequest).userId;
}