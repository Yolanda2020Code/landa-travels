CREATE TABLE IF NOT EXISTS recruitment_applications (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  email_normalized text NOT NULL,
  details text NOT NULL,
  consent boolean NOT NULL,
  cv_object_path text NOT NULL,
  cv_file_name text NOT NULL,
  cv_content_type text NOT NULL,
  cv_size integer NOT NULL,
  notification_status text NOT NULL DEFAULT 'not_required',
  notification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days'
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS recruitment_applications_email_normalized_uidx
  ON recruitment_applications (email_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS recruitment_applications_cv_object_path_uidx
  ON recruitment_applications (cv_object_path);
CREATE INDEX IF NOT EXISTS recruitment_applications_retention_expires_at_idx
  ON recruitment_applications (retention_expires_at);
ALTER TABLE recruitment_applications
  ALTER COLUMN notification_status SET DEFAULT 'not_required';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS recruitment_uploads (
  id serial PRIMARY KEY,
  object_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS recruitment_uploads_expires_at_idx
  ON recruitment_uploads (expires_at);