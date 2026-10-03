import { lt } from "drizzle-orm";
import { adminAuditLogTable, chatbotEventsTable, chatbotReviewsTable, conversationsTable, db } from "@workspace/db";
import { logger } from "../lib/logger";
import { retentionCutoffs } from "./chatbot-retention-helpers";

export const CHATBOT_RETENTION_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export async function cleanupChatbotRetention(now = new Date()): Promise<void> {
  const { telemetry: telemetryCutoff, audit: auditCutoff } = retentionCutoffs(now);
  await db.delete(conversationsTable).where(lt(conversationsTable.expiresAt, now));
  await db.delete(chatbotEventsTable).where(lt(chatbotEventsTable.occurredAt, telemetryCutoff));
  await db.delete(chatbotReviewsTable).where(lt(chatbotReviewsTable.createdAt, telemetryCutoff));
  await db.delete(adminAuditLogTable).where(lt(adminAuditLogTable.createdAt, auditCutoff));
}

export function createChatbotRetentionMaintenanceRunner(
  cleanup: () => Promise<void>,
  logFailure: (error: unknown) => void,
  now: () => number = Date.now,
  ttlMs = CHATBOT_RETENTION_MAINTENANCE_INTERVAL_MS,
): () => Promise<void> {
  let lastSuccessfulRunAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    if (now() - lastSuccessfulRunAt < ttlMs) return Promise.resolve();
    inFlight = Promise.resolve()
      .then(cleanup)
      .then(() => { lastSuccessfulRunAt = now(); })
      .catch((error: unknown) => {
        try {
          logFailure(error);
        } catch {
          // Maintenance and its logging must never interrupt request handling.
        }
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

const runRetentionMaintenance = createChatbotRetentionMaintenanceRunner(
  cleanupChatbotRetention,
  (err) => logger.error({ err }, "Chatbot retention cleanup failed"),
);

let retentionTimer: ReturnType<typeof setInterval> | null = null;
export function startChatbotRetentionMaintenance(): ReturnType<typeof setInterval> {
  if (retentionTimer) return retentionTimer;
  void runRetentionMaintenance();
  retentionTimer = setInterval(() => { void runRetentionMaintenance(); }, CHATBOT_RETENTION_MAINTENANCE_INTERVAL_MS);
  retentionTimer.unref?.();
  return retentionTimer;
}

export { safeEventPayload } from "./chatbot-retention-helpers";