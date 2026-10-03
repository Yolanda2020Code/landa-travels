DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_trips' AND column_name='travel_dates')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_trips' AND column_name='date_range') THEN
    ALTER TABLE saved_trips RENAME COLUMN travel_dates TO date_range;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_trips' AND column_name='travellers')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_trips' AND column_name='traveller_count') THEN
    ALTER TABLE saved_trips RENAME COLUMN travellers TO traveller_count;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_trips' AND column_name='sustainability_level')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='saved_trips' AND column_name='sustainability_priority') THEN
    ALTER TABLE saved_trips RENAME COLUMN sustainability_level TO sustainability_priority;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS conversations (
  id serial PRIMARY KEY,
  session_id text NOT NULL UNIQUE,
  user_id text,
  context jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS conversation_turns (
  id serial PRIMARY KEY,
  session_id text NOT NULL REFERENCES conversations(session_id) ON DELETE cascade,
  role text NOT NULL,
  content text NOT NULL,
  redacted_content text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);