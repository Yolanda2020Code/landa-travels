import type { NextFunction, Request, Response } from "express";
import { getRequestAuth } from "./clerkAuthConfig";

export type AuthenticatedRequest = Request & { userId: string };

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getRequestAuth(req);
  const rawUserId = auth?.sessionClaims?.userId || auth?.userId;
  const userId = typeof rawUserId === "string" ? rawUserId : null;
  if (!userId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  (req as AuthenticatedRequest).userId = userId;
  next();
}