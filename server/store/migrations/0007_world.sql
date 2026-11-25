ALTER TABLE works
  ADD COLUMN world_revision bigint NOT NULL DEFAULT 0 CHECK (world_revision >= 0);

CREATE TABLE world_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('category', 'item', 'calendar')),
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  position integer NOT NULL CHECK (position >= 0),
  fields jsonb,
  field_values jsonb,
  data_bytes integer NOT NULL DEFAULT 0 CHECK (data_bytes BETWEEN 0 AND 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'category' AND fields IS NOT NULL AND jsonb_typeof(fields) = 'array'
      AND field_values IS NULL AND data_bytes >= 2)
    OR
    (kind = 'item' AND parent_id IS NOT NULL AND field_values IS NOT NULL
      AND jsonb_typeof(field_values) = 'object' AND fields IS NULL AND data_bytes >= 2)
    OR
    (kind = 'calendar' AND parent_id IS NULL AND fields IS NULL AND field_values IS NULL AND data_bytes = 0)
  ),
  UNIQUE (work_id, id),
  FOREIGN KEY (work_id, parent_id) REFERENCES world_nodes(work_id, id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (work_id, parent_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX world_nodes_one_calendar_per_work ON world_nodes (work_id) WHERE kind = 'calendar';

CREATE TABLE world_calendars (
  work_id uuid PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
