/** Remove only this evaluation's explicitly named synthetic HTTP fixtures. */
import { and, eq, gte, like, or } from "drizzle-orm";
import { db, conversationsTable, conversationTurnsTable } from "@workspace/db";

const since = new Date("2026-10-02T21:15:00Z");
const rows = await db.select().from(conversationsTable).where(and(
  gte(conversationsTable.createdAt, since),
  or(
    like(conversationsTable.sessionId, "synthetic-robustness-%"),
    like(conversationsTable.sessionId, "synthetic-closing-%"),
    like(conversationsTable.sessionId, "synthetic-assignment-native-%"),
  ),
));
let cleared = 0;
for (const row of rows) {
  const namespace = (row.context as Record<string, unknown>)?.rasaConversationId;
  if (typeof namespace === "string") {
    const response = await fetch(`http://127.0.0.1:5005/conversations/${encodeURIComponent(namespace)}/tracker/events`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: "[]",
    });
    if (!response.ok) throw new Error("Synthetic native tracker cleanup failed; no database deletion attempted for this fixture.");
    const trackerResponse = await fetch(`http://127.0.0.1:5005/conversations/${encodeURIComponent(namespace)}/tracker`);
    const tracker = await trackerResponse.json();
    if (tracker.events.some((event: { event: string }) => event.event === "user" || event.event === "bot")) {
      throw new Error("Synthetic tracker still contains conversation events.");
    }
  }
  await db.delete(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, row.sessionId));
  await db.delete(conversationsTable).where(eq(conversationsTable.sessionId, row.sessionId));
  cleared++;
}
console.log(JSON.stringify({ synthetic_fixtures_removed: cleared, browser_fixture_cleanup_not_claimed: true }));