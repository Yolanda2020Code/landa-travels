import { and, eq, isNull, or } from "drizzle-orm";
import { conversationsTable, db } from "@workspace/db";

export function canUseConversationCorrelation(conversation: { userId: string | null } | undefined, userId: string): boolean {
  return !!conversation && (!conversation.userId || conversation.userId === userId);
}

export async function validateAndBindConversation(sessionId: string | undefined, userId: string): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const [claimed] = await db.update(conversationsTable)
    .set({ userId })
    .where(and(
      eq(conversationsTable.sessionId, sessionId),
      or(isNull(conversationsTable.userId), eq(conversationsTable.userId, userId)),
    ))
    .returning({ sessionId: conversationsTable.sessionId });
  return claimed?.sessionId;
}