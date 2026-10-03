CREATE TABLE IF NOT EXISTS chatbot_events (
  id serial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  session_id text NOT NULL,
  turn_id integer,
  event_type text NOT NULL,
  source text NOT NULL DEFAULT 'demo',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  latency_ms integer,
  confidence text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chatbot_evaluation_runs (
  id serial PRIMARY KEY,
  run_key text NOT NULL UNIQUE,
  dataset_version text NOT NULL,
  model_version text,
  command text NOT NULL,
  evaluation_type text NOT NULL DEFAULT 'labelled_evaluation',
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chatbot_evaluation_predictions (
  id serial PRIMARY KEY,
  run_id integer NOT NULL REFERENCES chatbot_evaluation_runs(id) ON DELETE CASCADE,
  sample_key text NOT NULL,
  task_type text NOT NULL,
  expected text,
  predicted text,
  confidence text,
  entities jsonb NOT NULL DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chatbot_reviews (
  id serial PRIMARY KEY,
  event_id text REFERENCES chatbot_events(event_id) ON DELETE SET NULL,
  session_id text NOT NULL,
  reviewer_id text NOT NULL,
  label text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id serial PRIMARY KEY,
  admin_user_id text NOT NULL,
  action text NOT NULL,
  resource text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chatbot_events_occurred_at_idx ON chatbot_events (occurred_at);
CREATE INDEX IF NOT EXISTS chatbot_events_session_id_idx ON chatbot_events (session_id);
CREATE INDEX IF NOT EXISTS chatbot_events_type_idx ON chatbot_events (event_type);
CREATE INDEX IF NOT EXISTS chatbot_predictions_run_id_idx ON chatbot_evaluation_predictions (run_id);
CREATE INDEX IF NOT EXISTS chatbot_reviews_created_at_idx ON chatbot_reviews (created_at);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at);
ALTER TABLE saved_trips ADD COLUMN IF NOT EXISTS conversation_session_id text;
CREATE INDEX IF NOT EXISTS saved_trips_conversation_session_id_idx ON saved_trips (conversation_session_id);