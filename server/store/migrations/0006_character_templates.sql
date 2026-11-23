CREATE TABLE character_templates (
  work_id uuid PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
