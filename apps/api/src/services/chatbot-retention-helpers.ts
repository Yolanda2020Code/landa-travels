export const CHATBOT_RETENTION_DAYS = 30;
export const ADMIN_AUDIT_RETENTION_DAYS = 90;

export function retentionCutoffs(now = new Date()) {
  return {
    telemetry: new Date(now.getTime() - CHATBOT_RETENTION_DAYS * 86400000),
    audit: new Date(now.getTime() - ADMIN_AUDIT_RETENTION_DAYS * 86400000),
  };
}

const ALLOWED_EVENT_KEYS = new Set(["intent", "entities", "slots", "count", "reason", "code", "transcriptTurns", "outcome", "messageLength"]);
export function safeEventPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([key]) => ALLOWED_EVENT_KEYS.has(key)));
}

export function derivedOutcome(eventType: string): string | undefined {
  return ({ completion: "completion", recommendation: "recommendation", save: "save", advisor_preview: "advisor_preview" } as Record<string, string>)[eventType];
}