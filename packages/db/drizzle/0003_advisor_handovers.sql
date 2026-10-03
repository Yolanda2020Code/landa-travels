CREATE TABLE IF NOT EXISTS advisor_handovers (
  id serial PRIMARY KEY,
  handover_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  saved_trip_id integer NOT NULL REFERENCES saved_trips(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'requested',
  summary text NOT NULL,
  privacy_context jsonb NOT NULL DEFAULT '{}',
  traveller_reply text,
  assigned_advisor_id text,
  assigned_advisor_name text,
  notification_status text NOT NULL DEFAULT 'pending',
  notification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  replied_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT advisor_handovers_status_check CHECK (status IN ('requested', 'assigned', 'replied', 'closed')),
  CONSTRAINT advisor_handovers_notification_status_check CHECK (notification_status IN ('accepted', 'pending', 'failed', 'not_configured'))
);

CREATE INDEX IF NOT EXISTS advisor_handovers_user_id_idx ON advisor_handovers (user_id);
CREATE INDEX IF NOT EXISTS advisor_handovers_status_created_at_idx ON advisor_handovers (status, created_at);
CREATE INDEX IF NOT EXISTS advisor_handovers_saved_trip_id_idx ON advisor_handovers (saved_trip_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'advisor_handovers_status_check') THEN
    ALTER TABLE advisor_handovers ADD CONSTRAINT advisor_handovers_status_check CHECK (status IN ('requested', 'assigned', 'replied', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'advisor_handovers_notification_status_check') THEN
    ALTER TABLE advisor_handovers ADD CONSTRAINT advisor_handovers_notification_status_check CHECK (notification_status IN ('accepted', 'pending', 'failed', 'not_configured'));
  END IF;
END $$;