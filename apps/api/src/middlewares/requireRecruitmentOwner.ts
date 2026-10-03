import type { NextFunction, Request, Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "./requireAuth";

type ClerkUser = {
  email_addresses?: Array<{
    email_address?: string;
    verification?: { status?: string };
  }>;
};

export function hasVerifiedOwnerEmail(user: ClerkUser, ownerEmail: string) {
  const normalizedOwner = ownerEmail.trim().toLowerCase();
  return user.email_addresses?.some((entry) =>
    entry.verification?.status === "verified"
    && entry.email_address?.trim().toLowerCase() === normalizedOwner
  ) ?? false;
}

export function requireRecruitmentOwner(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, async () => {
    const secretKey = process.env.CLERK_SECRET_KEY?.trim();
    const ownerEmail = process.env.RECRUITMENT_OWNER_EMAIL?.trim().toLowerCase()
      || process.env.RECRUITMENT_EMAIL?.trim().toLowerCase();
    if (!secretKey || !ownerEmail) {
      res.status(503).json({ error: "Private recruitment access is not configured." });
      return;
    }

    try {
      const userId = (req as AuthenticatedRequest).userId;
      const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        res.status(403).json({ error: "Recruitment owner access required." });
        return;
      }
      const user = await response.json() as ClerkUser;
      const isOwner = hasVerifiedOwnerEmail(user, ownerEmail);
      if (!isOwner) {
        res.status(403).json({ error: "Recruitment owner access required." });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "Private recruitment access is temporarily unavailable." });
    }
  });
}