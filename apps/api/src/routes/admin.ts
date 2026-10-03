import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  adminAuditLogTable, chatbotEventsTable, chatbotReviewsTable, conversationTurnsTable,
  conversationsTable, db, evaluationPredictionsTable, evaluationRunsTable,
} from "@workspace/db";
import { adminUserId, requireAdmin } from "../middlewares/requireAdmin";
import { rate, sampleState } from "../services/chatbot-aggregate";
import { cleanupChatbotRetention, safeEventPayload } from "../services/chatbot-retention";
import { aggregateChatbotFailures, aggregateChatbotOverview } from "../services/chatbot-admin-aggregates";

const router: IRouter = Router();
const MIN_SAMPLE = 5;
const value = (input: unknown) => typeof input === "string" ? input : undefined;
const dateFilter = (from: unknown, to: unknown, column: any) => {
  const clauses = [];
  if (value(from)?.match(/^\d{4}-\d{2}-\d{2}$/)) clauses.push(sql`${column} >= ${from}::date`);
  if (value(to)?.match(/^\d{4}-\d{2}-\d{2}$/)) clauses.push(sql`${column} < (${to}::date + interval '1 day')`);
  return clauses.length ? and(...clauses) : undefined;
};
const eventDateSql = (from: unknown, to: unknown, alias = sql`e`) => {
  const clauses = [];
  if (value(from)?.match(/^\d{4}-\d{2}-\d{2}$/)) clauses.push(sql`${alias}.occurred_at >= ${from}::date`);
  if (value(to)?.match(/^\d{4}-\d{2}-\d{2}$/)) clauses.push(sql`${alias}.occurred_at < (${to}::date + interval '1 day')`);
  return clauses.length ? sql`and ${sql.join(clauses, sql` and `)}` : sql``;
};
const safeId = (input: unknown) => Number.isInteger(Number(input)) && Number(input) > 0 ? Number(input) : null;
async function audit(req: any, action: string, resource?: string) {
  await db.insert(adminAuditLogTable).values({ adminUserId: adminUserId(req), action, resource, metadata: { redaction: "privacy_safe_projection" } });
}

router.get("/admin/chatbot/overview", requireAdmin, async (req, res) => {
  await cleanupChatbotRetention();
  const date = eventDateSql(req.query.from, req.query.to);
  const result = await db.execute(sql`
    with filtered as (select e.* from chatbot_events e where true ${date}),
    sessions as (
      select session_id, max(source) source,
        bool_or(event_type = 'completion') completed,
        bool_or(event_type in ('fallback','error')) fallback,
        bool_or(event_type in ('unresolved','unresolved_intent')) unresolved,
        bool_or(event_type in ('recommendation','request_recommendation','recommendation_request')) requested,
        bool_or(event_type = 'save') saved,
        bool_or(event_type = 'demo_booking_request') booking,
        bool_or(event_type in ('advisor_preview','advisor_handover')) advisor
      from filtered group by session_id
    )
    select count(*)::int sessions, count(*) filter (where completed)::int completed,
      count(*) filter (where fallback)::int fallback, count(*) filter (where unresolved)::int unresolved,
      count(*) filter (where requested)::int requested, count(*) filter (where saved)::int saved,
      count(*) filter (where booking)::int booking, count(*) filter (where advisor)::int advisor from sessions
  `);
  const row = (result.rows[0] || {}) as Record<string, any>;
  const aggregate = await aggregateChatbotOverview(value(req.query.from), value(req.query.to));
  row.sessions = aggregate.sessions;
  row.completed = aggregate.completed;
  row.fallback = aggregate.fallback;
  const sessions = Number(row.sessions || 0);
  const latency = await db.execute(sql`select
    coalesce(percentile_cont(0.5) within group (order by latency_ms),0)::int p50,
    coalesce(percentile_cont(0.95) within group (order by latency_ms),0)::int p95
    from chatbot_events e where e.event_type = 'turn' and e.latency_ms is not null ${date}`);
  const sourceRows = await db.execute(sql`
    with filtered as (select e.* from chatbot_events e where true ${date})
    select source, count(distinct session_id)::int sessions from filtered group by source order by source`);
  const dailyRows = await db.execute(sql`
    with filtered as (select e.* from chatbot_events e where true ${date})
    select date_trunc('day', occurred_at)::date day, count(distinct session_id)::int sessions,
      count(distinct session_id) filter (where event_type = 'completion')::int completions,
      count(distinct session_id) filter (where event_type in ('fallback','error'))::int fallbacks
    from filtered group by 1 order by 1`);
  const metric = (n: number) => rate(n, sessions, MIN_SAMPLE);
  const requested = Number(row.requested || 0);
  const latencyRow = (latency.rows[0] || {}) as Record<string, any>;
  res.json({
    dataSource: "live_telemetry", minimumSample: MIN_SAMPLE,
    metrics: {
      volume: { value: sessions, sampleSize: sessions, state: sampleState(sessions) },
      sessions: { value: sessions, sampleSize: sessions, state: sampleState(sessions) },
      completionRate: metric(Number(row.completed || 0)),
      fallbackRate: metric(Number(row.fallback || 0)),
      unresolvedRate: metric(Number(row.unresolved || 0)),
      requestConversion: metric(Number(row.requested || 0)),
      saveConversion: rate(Number(row.saved || 0), requested, MIN_SAMPLE),
      bookingRequestConversion: rate(Number(row.booking || 0), sessions, MIN_SAMPLE),
      advisorConversion: metric(Number(row.advisor || 0)),
      latencyMs: { p50: Number(latencyRow.p50 || 0), p95: Number(latencyRow.p95 || 0), sampleSize: sessions, state: sampleState(sessions) },
    },
    sourceBreakdown: sourceRows.rows,
    dailyTimeSeries: dailyRows.rows,
  });
});

router.get("/admin/chatbot/funnel", requireAdmin, async (req, res) => {
  await cleanupChatbotRetention();
  const date = eventDateSql(req.query.from, req.query.to);
  const result = await db.execute(sql`
    with filtered as (select e.* from chatbot_events e where true ${date}),
    stages(name, event_type, ordinal) as (values
      ('started','turn',1), ('slots_collected','slot_change',2), ('recommendations','recommendation',3),
      ('saved','save',4), ('advisor','advisor_preview',5), ('completed','completion',6))
    select s.name, s.ordinal, count(distinct f.session_id)::int sessions
    from stages s left join filtered f on f.event_type = s.event_type
    group by s.name,s.ordinal order by s.ordinal`);
  const slots = await db.execute(sql`
    with filtered as (select e.* from chatbot_events e where true ${date})
    select slot, count(distinct session_id)::int sessions
    from filtered cross join lateral jsonb_array_elements_text(coalesce(payload->'slots', payload->'changedSlots','[]'::jsonb)) slot
    where event_type = 'slot_change' group by slot order by sessions desc`);
  res.json({ dataSource: "live_telemetry", minimumSample: MIN_SAMPLE,
    journeyStages: result.rows.map((r: any) => ({ ...r, state: sampleState(Number(r.sessions)) })),
    slotDropoff: slots.rows.map((r: any) => ({ ...r, state: sampleState(Number(r.sessions)) })) });
});

router.get("/admin/chatbot/failures", requireAdmin, async (req, res) => {
  await cleanupChatbotRetention();
  const date = eventDateSql(req.query.from, req.query.to);
  const type = value(req.query.type);
  const source = value(req.query.source);
  const outcome = value(req.query.outcome);
  const typeFilter = type === "high-fallback" ? sql`and e.event_type in ('fallback','unresolved','unresolved_intent')`
    : type === "repeated-prompt" ? sql`and e.event_type = 'repeated_prompt'`
      : type === "abandoned-form" ? sql`and e.event_type = 'abandoned_form'`
        : type === "source-destination-confusion" ? sql`and e.event_type = 'source_destination_confusion'` : sql``;
  const filters = sql`${typeFilter}
    ${source ? sql`and e.source = ${source}` : sql``}
    ${outcome ? sql`and exists (
      select 1 from chatbot_events outcome_event
      where outcome_event.session_id = e.session_id and outcome_event.event_type = ${outcome}
    )` : sql``}`;
  const rows = await db.execute(sql`
    select e.event_id "eventId", e.session_id "sessionId", e.event_type "eventType", e.source,
      e.confidence, e.occurred_at "occurredAt", e.payload
    from chatbot_events e where (e.event_type in ('fallback','error','repeated_prompt','abandoned_form',
      'source_destination_confusion','unresolved','unresolved_intent'))
      ${date} ${filters} order by e.occurred_at desc limit 200`);
  const cohorts = await aggregateChatbotFailures(value(req.query.from), value(req.query.to));
  // Abandonment is derived from durable conversation state, not persisted as an
  // event. Thirty minutes of inactivity with no completion is the documented
  // threshold; only counts and a synthetic privacy-safe cohort are exposed.
  const abandoned = await db.execute(sql`
    select count(*)::int count from conversations c
    where c.updated_at < now() - interval '30 minutes'
      and coalesce(c.context->>'reviewConfirmation', 'false') <> 'true'
      ${value(req.query.from)?.match(/^\d{4}-\d{2}-\d{2}$/) ? sql`and c.updated_at >= ${req.query.from}::date` : sql``}
      ${value(req.query.to)?.match(/^\d{4}-\d{2}-\d{2}$/) ? sql`and c.updated_at < (${req.query.to}::date + interval '1 day')` : sql``}`);
  const abandonedCount = Number((abandoned.rows[0] as any)?.count || 0);
  const cohortRows = [...cohorts];
  if (abandonedCount) cohortRows.push({ cohort: "abandoned-form", count: abandonedCount });
  res.json({ dataSource: "live_telemetry", minimumSample: MIN_SAMPLE, cohorts: cohortRows.map((r: any) => ({ ...r, state: sampleState(Number(r.count)) })), rows: rows.rows.map((row: any) => ({ ...row, payload: safeEventPayload(row.payload) })), privacy: "redacted_metadata_only", abandonment: { thresholdMinutes: 30, derived: true, sessions: abandonedCount } });
});

router.get("/admin/chatbot/conversations", requireAdmin, async (req, res) => {
  await cleanupChatbotRetention();
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const q = value(req.query.q);
  const outcome = value(req.query.outcome);
  const source = value(req.query.source);
  const failureClass = value(req.query.failureClass);
  const where = dateFilter(req.query.from, req.query.to, conversationsTable.updatedAt);
  const filters = [
    where,
    q ? ilike(conversationsTable.sessionId, `%${q}%`) : undefined,
    source ? sql`exists (select 1 from chatbot_events se where se.session_id = ${conversationsTable.sessionId} and se.source = ${source})` : undefined,
    outcome ? sql`exists (select 1 from chatbot_events oe where oe.session_id = ${conversationsTable.sessionId} and
      case when oe.event_type = 'completion' then 'completion' when oe.event_type = 'recommendation' then 'recommendation'
      when oe.event_type = 'save' then 'save' when oe.event_type = 'advisor_preview' then 'advisor_preview' else null end = ${outcome})` : undefined,
    failureClass ? sql`exists (select 1 from chatbot_events fe where fe.session_id = ${conversationsTable.sessionId} and fe.event_type = ${failureClass})` : undefined,
  ].filter(Boolean) as any[];
  const rows = await db.select({
    sessionId: conversationsTable.sessionId, createdAt: conversationsTable.createdAt, updatedAt: conversationsTable.updatedAt, expiresAt: conversationsTable.expiresAt,
    turnCount: sql<number>`(select count(*) from conversation_turns t where t.session_id = ${conversationsTable.sessionId})::int`,
    fallbackCount: sql<number>`(select count(*) from chatbot_events f where f.session_id = ${conversationsTable.sessionId} and f.event_type in ('fallback','error'))::int`,
    source: sql<string>`coalesce((select e.source from chatbot_events e where e.session_id = ${conversationsTable.sessionId} order by e.occurred_at desc limit 1),'unknown')`,
    outcome: sql<string>`coalesce((select case when e.event_type = 'completion' then 'completion' when e.event_type = 'recommendation' then 'recommendation' when e.event_type = 'save' then 'save' when e.event_type = 'advisor_preview' then 'advisor_preview' end from chatbot_events e where e.session_id = ${conversationsTable.sessionId} and e.event_type in ('completion','recommendation','save','advisor_preview') order by e.occurred_at desc limit 1),'in_progress')`,
    status: sql<string>`case when ${conversationsTable.expiresAt} < now() then 'expired' else coalesce((select e.payload->>'status' from chatbot_events e where e.session_id = ${conversationsTable.sessionId} and e.payload->>'status' is not null order by e.occurred_at desc limit 1),'active') end`,
    latestReviewLabel: sql<string>`(select r.label from chatbot_reviews r where r.session_id = ${conversationsTable.sessionId} order by r.created_at desc limit 1)`,
  }).from(conversationsTable).where(filters.length ? and(...filters) : undefined).orderBy(desc(conversationsTable.updatedAt)).limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(conversationsTable).where(filters.length ? and(...filters) : undefined);
  await audit(req, "conversation_list", "chatbot");
  res.json({ dataSource: "live_telemetry", rows, total: Number(count), limit, offset, privacy: "redacted_metadata_only" });
});

router.get("/admin/chatbot/conversations/:sessionId", requireAdmin, async (req, res) => {
  await cleanupChatbotRetention();
  const sessionId = String(req.params.sessionId);
  const turns = await db.select({ id: conversationTurnsTable.id, role: conversationTurnsTable.role, content: conversationTurnsTable.redactedContent, createdAt: conversationTurnsTable.createdAt })
    .from(conversationTurnsTable).where(eq(conversationTurnsTable.sessionId, sessionId)).orderBy(conversationTurnsTable.createdAt);
  const events = await db.select({ eventId: chatbotEventsTable.eventId, eventType: chatbotEventsTable.eventType, source: chatbotEventsTable.source, occurredAt: chatbotEventsTable.occurredAt, payload: chatbotEventsTable.payload })
    .from(chatbotEventsTable).where(eq(chatbotEventsTable.sessionId, sessionId)).orderBy(chatbotEventsTable.occurredAt);
  const reviews = await db.select({ id: chatbotReviewsTable.id, label: chatbotReviewsTable.label, createdAt: chatbotReviewsTable.createdAt })
    .from(chatbotReviewsTable).where(eq(chatbotReviewsTable.sessionId, sessionId)).orderBy(desc(chatbotReviewsTable.createdAt));
  await audit(req, "conversation_detail", sessionId);
  res.json({ dataSource: "live_telemetry", sessionId, turns, events: events.map((event) => ({ ...event, payload: safeEventPayload(event.payload) })), reviews, privacy: "redacted_only" });
});

function metricSummary(predictions: Array<{ expected: string | null; predicted: string | null; confidence: string | null }>) {
  const labels = [...new Set(predictions.flatMap((p) => [p.expected, p.predicted]).filter(Boolean))] as string[];
  const perLabel = labels.map((label) => {
    const tp = predictions.filter((p) => p.expected === label && p.predicted === label).length;
    const fp = predictions.filter((p) => p.expected !== label && p.predicted === label).length;
    const fn = predictions.filter((p) => p.expected === label && p.predicted !== label).length;
    const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
    return { label, support: tp + fn, precision, recall, f1: 2 * precision * recall / (precision + recall || 1) };
  });
  const confidences = predictions.filter((p) => p.confidence != null).map((p) => Number(p.confidence)).filter(Number.isFinite);
  return { support: predictions.length, accuracy: predictions.length ? predictions.filter((p) => p.expected === p.predicted).length / predictions.length : 0,
    macro: perLabel.length ? Object.fromEntries(["precision", "recall", "f1"].map((k) => [k, perLabel.reduce((s, p) => s + Number(p[k as "precision"]), 0) / perLabel.length])) : { precision: 0, recall: 0, f1: 0 },
    confidence: { mean: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null, count: confidences.length },
    perLabel };
}

router.get("/admin/chatbot/evaluations", requireAdmin, async (_req, res) => {
  const runs = await db.select().from(evaluationRunsTable).orderBy(desc(evaluationRunsTable.createdAt));
  const summaries = await Promise.all(runs.map(async (run) => {
    const predictions = await db.select({ expected: evaluationPredictionsTable.expected, predicted: evaluationPredictionsTable.predicted, confidence: evaluationPredictionsTable.confidence }).from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runId, run.id));
    return { ...run, metricSummary: metricSummary(predictions) };
  }));
  res.json({ dataSource: "labelled_evaluation", rows: summaries });
});

async function evaluation(req: any, res: any) {
  const id = safeId(req.params.id);
  if (!id) { res.status(404).json({ error: "Evaluation run not found." }); return null; }
  const [run] = await db.select().from(evaluationRunsTable).where(eq(evaluationRunsTable.id, id));
  if (!run) { res.status(404).json({ error: "Evaluation run not found." }); return null; }
  return run;
}
router.get("/admin/chatbot/evaluations/:id", requireAdmin, async (req, res) => {
  const run = await evaluation(req, res); if (!run) return;
  const predictions = await db.select().from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runId, run.id));
  await audit(req, "evaluation_detail", String(run.id));
  res.json({ dataSource: "labelled_evaluation", run, metricSummary: metricSummary(predictions), predictions });
});
router.get("/admin/chatbot/evaluations/:id/confusion-matrix", requireAdmin, async (req, res) => {
  const run = await evaluation(req, res); if (!run) return;
  const rows = await db.select({ expected: evaluationPredictionsTable.expected, predicted: evaluationPredictionsTable.predicted, count: sql<number>`count(*)::int` }).from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runId, run.id)).groupBy(evaluationPredictionsTable.expected, evaluationPredictionsTable.predicted);
  await audit(req, "evaluation_confusion_matrix", String(run.id));
  res.json({ dataSource: "labelled_evaluation", runId: run.id, minimumSample: MIN_SAMPLE, rows });
});
router.get("/admin/chatbot/evaluations/:id/export", requireAdmin, async (req, res) => {
  const run = await evaluation(req, res); if (!run) return;
  const rows = await db.select().from(evaluationPredictionsTable).where(eq(evaluationPredictionsTable.runId, run.id));
  await audit(req, "evaluation_export", String(run.id));
  if (req.query.format === "csv") {
    res.type("text/csv").send(["sampleKey,taskType,expected,predicted,confidence", ...rows.map((r) => [r.sampleKey, r.taskType, r.expected || "", r.predicted || "", r.confidence || ""].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))].join("\n")); return;
  }
  res.json({ dataSource: "labelled_evaluation", runId: run.id, rows });
});
router.post("/admin/chatbot/reviews", requireAdmin, async (req, res) => {
  const { eventId, sessionId, label } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof label !== "string" || label.length > 80) { res.status(400).json({ error: "sessionId and a review label are required." }); return; }
  const [review] = await db.insert(chatbotReviewsTable).values({ eventId: typeof eventId === "string" ? eventId : undefined, sessionId, reviewerId: adminUserId(req), label }).returning();
  await audit(req, "conversation_review", sessionId);
  res.status(201).json({ dataSource: "live_telemetry", review: { id: review.id, label: review.label, createdAt: review.createdAt } });
});
export default router;