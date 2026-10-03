import { randomUUID } from "node:crypto";
import { db, chatbotEventsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export function conversationSessionHeader(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate)) return undefined;
  return candidate;
}

export async function recordChatbotEvent(input: {
  sessionId: string;
  eventType: string;
  source?: string;
  latencyMs?: number;
  confidence?: number;
  payload?: Record<string, unknown>;
  turnId?: number;
}): Promise<string> {
  const eventId = randomUUID();
  try {
    await db.insert(chatbotEventsTable).values({
      eventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      eventType: input.eventType,
      source: input.source ?? "demo",
      latencyMs: input.latencyMs,
      confidence: input.confidence == null ? undefined : String(input.confidence),
      payload: input.payload ?? {},
    }).onConflictDoNothing({ target: chatbotEventsTable.eventId });
  } catch (error) {
    // Telemetry must never make a traveller request fail, but failures are observable.
    logger.warn({ err: error, eventType: input.eventType }, "Unable to persist chatbot telemetry");
  }
  return eventId;
}