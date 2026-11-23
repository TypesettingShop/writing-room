ALTER TABLE works
  ADD COLUMN characters_revision bigint NOT NULL DEFAULT 0 CHECK (characters_revision >= 0);

CREATE TABLE characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('folder', 'character')),
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  position integer NOT NULL CHECK (position >= 0),
  type text DEFAULT 'unknown' CHECK (type IN ('male', 'female', 'unknown', 'animal')),
  field_values jsonb,
  values_bytes integer NOT NULL DEFAULT 0 CHECK (values_bytes BETWEEN 0 AND 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'folder' AND type IS NULL AND field_values IS NULL AND values_bytes = 0)
    OR
    (kind = 'character' AND type IS NOT NULL AND field_values IS NOT NULL
      AND jsonb_typeof(field_values) = 'object' AND ((field_values = '{}'::jsonb) = (values_bytes = 0)))
  ),
  UNIQUE (work_id, id),
  FOREIGN KEY (work_id, parent_id) REFERENCES characters(work_id, id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (work_id, parent_id, position) DEFERRABLE INITIALLY DEFERRED
);
