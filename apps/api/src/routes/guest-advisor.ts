import { Router, type Request, type Response } from "express";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db, advisorHandoversTable, conversationsTable, conversationTurnsTable } from "@workspace/db";
import { GetGuestHandoverStatusBody, GetGuestHandoverStatusResponse, RequestAdvisorHandoverBody, RequestAdvisorHandoverResponse } from "@workspace/api-zod";
import { getRasaHandoverContext, RasaUnavailableError } from "../services/rasa-gateway";
import { boundAndRedactTranscript, buildHandoverSummary, minimizeHandoverContext, newHandoverId, notifyAdvisorInbox, recommendationSnapshotFromUnknown, recommendationSnapshotMatchesContext, tripContextFingerprint } from "../services/advisor-handover";

export const ASYNC_ADVISOR_MESSAGE = "This is not live chat. An advisor will review your request during staffed hours and reply later; timing depends on advisor availability.";
const router = Router();

export async function requestGuestAdvisor(req: Request, res: Response, activeRequests: Set<string>): Promise<void> {
  const body = RequestAdvisorHandoverBody.parse(req.body);
  if (!body.sessionId || !body.contactEmail) {
    res.status(400).json({ error: "Provide your active planning conversation and a valid email address for the advisor's reply." }); return;
  }
  const [conversation] = await db.select().from(conversationsTable).where(and(
    eq(conversationsTable.sessionId, body.sessionId), isNull(conversationsTable.userId),
    gt(conversationsTable.expiresAt, new Date(Date.now() + 5 * 60_000)),
  )).limit(1);
  if (!conversation) { res.status(404).json({ error: "Start or resume your guest conversation before requesting advisor help." }); return; }
  const [previous] = await db.select().from(advisorHandoversTable).where(eq(advisorHandoversTable.guestSessionId, body.sessionId)).limit(1);
  if (previous) {
    res.json(RequestAdvisorHandoverResponse.parse({
      handoverId: previous.handoverId, status: previous.status, summary: previous.summary,
      deliveryStatus: previous.notificationStatus, slaMessage: ASYNC_ADVISOR_MESSAGE,
      nextStep: "This conversation already has an advisor request. Check its status below; it has not been submitted twice.",
    })); return;
  }
  const metadata = conversation.context as Record<string, unknown>;
  const namespace = typeof metadata.rasaConversationId === "string" ? metadata.rasaConversationId : null;
  if (!namespace) { res.status(409).json({ error: "Resume guided planning before requesting advisor help." }); return; }
  if (activeRequests.has(namespace)) { res.status(429).json({ error: "Wait for the current planning answer, then retry your advisor request." }); return; }
  activeRequests.add(namespace);
  try {
    const context = await getRasaHandoverContext(namespace);
    if (typeof metadata.planningContextFingerprint !== "string" || tripContextFingerprint(context) !== metadata.planningContextFingerprint) {
      res.status(409).json({ error: "Your conversation has changed. Resume planning before sharing its context." }); return;
    }
    const storedSnapshot = recommendationSnapshotFromUnknown(metadata.recommendationSnapshot);
    const snapshot = storedSnapshot && recommendationSnapshotMatchesContext(storedSnapshot, context) ? storedSnapshot : null;
    const selection = [...new Set(body.selectedRecommendationIds ?? [])];
    if (selection.length !== (body.selectedRecommendationIds ?? []).length ||
        selection.some((id) => !snapshot?.recommendations.some((option) => option.id === id))) {
      res.status(400).json({ error: "Selected options must belong to this conversation's current displayed results." }); return;
    }
    const turns = await db.select().from(conversationTurnsTable)
      .where(eq(conversationTurnsTable.sessionId, body.sessionId))
      .orderBy(desc(conversationTurnsTable.createdAt), desc(conversationTurnsTable.id)).limit(30);
    const transcript = boundAndRedactTranscript(turns.reverse()
      .filter((turn) => turn.role === "user" || turn.role === "assistant")
      .map((turn) => ({ role: turn.role as "user" | "assistant", content: turn.redactedContent ?? turn.content })));
    const summary = buildHandoverSummary(context, transcript.length, snapshot?.recommendations.length ?? 0, selection.length);
    const handover = await db.transaction(async (tx) => {
      const [fresh] = await tx.select().from(conversationsTable)
        .where(eq(conversationsTable.sessionId, body.sessionId!)).for("update");
      const freshMetadata = fresh?.context as Record<string, unknown> | undefined;
      if (!fresh || fresh.userId !== null || fresh.expiresAt.getTime() <= Date.now() + 5 * 60_000 ||
          freshMetadata?.rasaConversationId !== namespace ||
          freshMetadata?.planningContextFingerprint !== metadata.planningContextFingerprint) return null;
      const [row] = await tx.insert(advisorHandoversTable).values({
        handoverId: newHandoverId(), guestSessionId: body.sessionId,
        contactEmail: body.contactEmail!.trim().toLowerCase(), summary,
        privacyContext: minimizeHandoverContext(context, snapshot, selection), transcript,
        notificationStatus: "pending",
      }).onConflictDoNothing().returning();
      return row ?? null;
    });
    if (!handover) { res.status(409).json({ error: "The conversation changed or a request already exists. Resume planning or check its request status before retrying." }); return; }
    const notification = await notifyAdvisorInbox(handover.handoverId, summary);
    await db.update(advisorHandoversTable).set({
      notificationStatus: notification.status, notificationError: notification.error ?? null,
    }).where(eq(advisorHandoversTable.id, handover.id));
    res.json(RequestAdvisorHandoverResponse.parse({
      handoverId: handover.handoverId, status: handover.status, summary,
      deliveryStatus: notification.status, slaMessage: ASYNC_ADVISOR_MESSAGE,
      nextStep: `Your request is saved in the advisor inbox. Check its status here; an advisor can also reply to your supplied email. ${notification.status === "accepted" ? "The inbox notification was accepted by the email provider." : "Inbox email notification is not confirmed; the saved request is still available to advisors."}`,
    }));
  } catch (error) {
    if (error instanceof RasaUnavailableError) { res.status(503).json({ error: error.message }); return; }
    throw error;
  } finally { activeRequests.delete(namespace); }
}

router.post("/assistant/handover/status", async (req, res): Promise<void> => {
  const body = GetGuestHandoverStatusBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid advisor request reference." }); return; }
  const [row] = await db.select({ handover: advisorHandoversTable })
    .from(advisorHandoversTable).innerJoin(conversationsTable,
      eq(advisorHandoversTable.guestSessionId, conversationsTable.sessionId))
    .where(and(
      eq(advisorHandoversTable.handoverId, body.data.handoverId),
      eq(advisorHandoversTable.guestSessionId, body.data.sessionId),
      isNull(advisorHandoversTable.userId), isNull(conversationsTable.userId),
      gt(conversationsTable.expiresAt, new Date()),
    )).limit(1);
  if (!row) { res.status(404).json({ error: "Request unavailable or guest conversation expired." }); return; }
  res.json(GetGuestHandoverStatusResponse.parse(row.handover));
});

export default router;