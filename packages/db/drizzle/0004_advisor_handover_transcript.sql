ALTER TABLE advisor_handovers
  ADD COLUMN IF NOT EXISTS transcript jsonb NOT NULL DEFAULT '[]'::jsonb;