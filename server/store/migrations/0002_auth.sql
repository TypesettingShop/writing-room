ALTER TABLE users
  ADD COLUMN email text,
  ADD COLUMN email_normalized text UNIQUE,
  ADD COLUMN password_hash text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

CREATE INDEX sessions_expires_at ON sessions (expires_at);
CREATE INDEX sessions_user_expires_at ON sessions (user_id, expires_at);
