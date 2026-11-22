CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  tree_revision bigint NOT NULL DEFAULT 0 CHECK (tree_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX works_owner_updated ON works (owner_id, updated_at DESC, id);

CREATE TABLE nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('part', 'chapter', 'document')),
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  position integer NOT NULL CHECK (position >= 0),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id, id),
  FOREIGN KEY (work_id, parent_id) REFERENCES nodes(work_id, id) ON DELETE CASCADE,
  UNIQUE NULLS NOT DISTINCT (work_id, parent_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE documents (
  node_id uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  mtime_ms bigint NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 8388608)
);
