import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, advisorHandoversTable } from "@workspace/db";
import {
  AssignAdvisorHandoverBody, AssignAdvisorHandoverParams, AssignAdvisorHandoverResponse,
  CloseAdvisorHandoverParams, CloseAdvisorHandoverResponse, GetAdvisorHandoverParams,
  GetAdvisorHandoverResponse, ListAdvisorHandoversResponse, ReplyToAdvisorHandoverBody,
  ReplyToAdvisorHandoverParams, ReplyToAdvisorHandoverResponse,
} from "@workspace/api-zod";
import { requireAdvisor } from "../middlewares/requireAdmin";
import { type AuthenticatedRequest } from "../middlewares/requireAuth";
import { notifyGuestAdvisorReply } from "../services/advisor-handover";

const router: IRouter = Router();
const currentAdvisor = (req: AuthenticatedRequest) => req.userId;

router.get("/advisor/handovers", requireAdvisor, async (_req, res): Promise<void> => {
  const rows = await db.select().from(advisorHandoversTable).orderBy(desc(advisorHandoversTable.createdAt));
  res.json(ListAdvisorHandoversResponse.parse(rows));
});

router.get("/advisor/handovers/:id", requireAdvisor, async (req, res): Promise<void> => {
  const params = GetAdvisorHandoverParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid handover reference." }); return; }
  const advisorId = currentAdvisor(req as AuthenticatedRequest);
  const [row] = await db.select().from(advisorHandoversTable).where(and(
    eq(advisorHandoversTable.handoverId, params.data.id),
    eq(advisorHandoversTable.assignedAdvisorId, advisorId),
  )).limit(1);
  if (!row) { res.status(404).json({ error: "Handover not found or not assigned to this advisor." }); return; }
  res.json(GetAdvisorHandoverResponse.parse({
    handover: row,
    context: row.privacyContext,
    transcript: row.transcript,
    contactEmail: row.contactEmail,
  }));
});

router.post("/advisor/handovers/:id/assign", requireAdvisor, async (req, res): Promise<void> => {
  const params = AssignAdvisorHandoverParams.safeParse(req.params);
  const body = AssignAdvisorHandoverBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid handover assignment." }); return; }
  const advisorId = currentAdvisor(req as AuthenticatedRequest);
  const [existing] = await db.select({ id: advisorHandoversTable.id }).from(advisorHandoversTable)
    .where(eq(advisorHandoversTable.handoverId, params.data.id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Handover not found." }); return; }
  const now = new Date();
  const [row] = await db.update(advisorHandoversTable).set({
    status: "assigned",
    assignedAdvisorId: advisorId,
    assignedAdvisorName: "Advisor",
    assignedAt: now,
    updatedAt: now,
  }).where(and(
    eq(advisorHandoversTable.handoverId, params.data.id),
    eq(advisorHandoversTable.status, "requested"),
    isNull(advisorHandoversTable.assignedAdvisorId),
  )).returning();
  if (!row) { res.status(409).json({ error: "This handover has already been assigned or is no longer available." }); return; }
  res.json(AssignAdvisorHandoverResponse.parse(row));
});

router.post("/advisor/handovers/:id/reply", requireAdvisor, async (req, res): Promise<void> => {
  const params = ReplyToAdvisorHandoverParams.safeParse(req.params);
  const body = ReplyToAdvisorHandoverBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Enter a reply of up to 4,000 characters." }); return; }
  const advisorId = currentAdvisor(req as AuthenticatedRequest);
  const [existing] = await db.select({ id: advisorHandoversTable.id }).from(advisorHandoversTable)
    .where(eq(advisorHandoversTable.handoverId, params.data.id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Handover not found." }); return; }
  const now = new Date();
  const [row] = await db.update(advisorHandoversTable).set({
    status: "replied",
    travellerReply: body.data.reply.trim(),
    repliedAt: now,
    replyNotificationStatus: "pending",
    updatedAt: now,
  }).where(and(
    eq(advisorHandoversTable.handoverId, params.data.id),
    eq(advisorHandoversTable.status, "assigned"),
    eq(advisorHandoversTable.assignedAdvisorId, advisorId),
  )).returning();
  if (!row) { res.status(409).json({ error: "Only the assigned advisor can reply to an assigned handover." }); return; }
  const notification = row.contactEmail
    ? await notifyGuestAdvisorReply(row.handoverId, row.contactEmail, row.travellerReply!)
    : { status: "not_requested" };
  const [updated] = await db.update(advisorHandoversTable).set({
    replyNotificationStatus: notification.status,
  }).where(and(eq(advisorHandoversTable.id, row.id), eq(advisorHandoversTable.assignedAdvisorId, advisorId))).returning();
  res.json(ReplyToAdvisorHandoverResponse.parse(updated));
});

router.post("/advisor/handovers/:id/close", requireAdvisor, async (req, res): Promise<void> => {
  const params = CloseAdvisorHandoverParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid handover reference." }); return; }
  const advisorId = currentAdvisor(req as AuthenticatedRequest);
  const [existing] = await db.select({ id: advisorHandoversTable.id }).from(advisorHandoversTable)
    .where(eq(advisorHandoversTable.handoverId, params.data.id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Handover not found." }); return; }
  const now = new Date();
  const [row] = await db.update(advisorHandoversTable).set({
    status: "closed",
    closedAt: now,
    updatedAt: now,
  }).where(and(
    eq(advisorHandoversTable.handoverId, params.data.id),
    eq(advisorHandoversTable.status, "replied"),
    eq(advisorHandoversTable.assignedAdvisorId, advisorId),
  )).returning();
  if (!row) { res.status(409).json({ error: "Only the assigned advisor can close a replied handover." }); return; }
  res.json(CloseAdvisorHandoverResponse.parse(row));
});

router.post("/advisor/handovers/:id/reply-email", requireAdvisor, async (req, res): Promise<void> => {
  const id = String(req.params.id ?? "");
  const advisorId = currentAdvisor(req as AuthenticatedRequest);
  const [row] = await db.select().from(advisorHandoversTable).where(and(
    eq(advisorHandoversTable.handoverId, id),
    eq(advisorHandoversTable.assignedAdvisorId, advisorId),
  )).limit(1);
  if (!row?.contactEmail || !row.travellerReply || !["replied", "closed"].includes(row.status)) {
    res.status(404).json({ error: "No saved guest reply is assigned to this advisor." }); return;
  }
  const notification = await notifyGuestAdvisorReply(row.handoverId, row.contactEmail, row.travellerReply);
  const [updated] = await db.update(advisorHandoversTable).set({ replyNotificationStatus: notification.status })
    .where(and(eq(advisorHandoversTable.id, row.id), eq(advisorHandoversTable.assignedAdvisorId, advisorId))).returning();
  res.json(ReplyToAdvisorHandoverResponse.parse(updated));
});

export default router;