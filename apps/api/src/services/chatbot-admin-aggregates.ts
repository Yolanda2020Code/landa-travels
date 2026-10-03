import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export async function aggregateChatbotOverview(from?: string, to?: string, sessionIds?: string[]) {
  const date = sql`
    ${from?.match(/^\d{4}-\d{2}-\d{2}$/) ? sql`and occurred_at >= ${from}::date` : sql``}
    ${to?.match(/^\d{4}-\d{2}-\d{2}$/) ? sql`and occurred_at < (${to}::date + interval '1 day')` : sql``}
    ${sessionIds?.length ? sql`and session_id in (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`;
  const result = await db.execute(sql`
    with sessions as (
      select session_id,
        bool_or(event_type = 'completion') completed,
        bool_or(event_type in ('fallback','error')) fallback
      from chatbot_events where true ${date} group by session_id
    )
    select count(*)::int sessions,
      count(*) filter (where completed)::int completed,
      count(*) filter (where fallback)::int fallback
    from sessions`);
  return (result.rows[0] || {}) as Record<string, unknown>;
}

export async function aggregateChatbotFailures(from?: string, to?: string, sessionIds?: string[]) {
  const date = sql`
    ${from?.match(/^\d{4}-\d{2}-\d{2}$/) ? sql`and e.occurred_at >= ${from}::date` : sql``}
    ${to?.match(/^\d{4}-\d{2}-\d{2}$/) ? sql`and e.occurred_at < (${to}::date + interval '1 day')` : sql``}
    ${sessionIds?.length ? sql`and e.session_id in (${sql.join(sessionIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`;
  const result = await db.execute(sql`
    select case when event_type = 'error' then 'assistant-error'
      when event_type = 'repeated_prompt' then 'repeated-prompt'
      when event_type = 'abandoned_form' then 'abandoned-form'
      when event_type = 'source_destination_confusion' then 'source-destination-confusion'
      else 'high-fallback' end cohort, count(*)::int count
    from chatbot_events e
    where event_type in ('fallback','error','repeated_prompt','abandoned_form',
      'source_destination_confusion','unresolved','unresolved_intent') ${date}
    group by 1`);
  return result.rows as Array<{ cohort: string; count: number }>;
}