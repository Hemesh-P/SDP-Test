BEGIN;

CREATE TABLE IF NOT EXISTS repositories (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  source_type varchar(16) NOT NULL CHECK (source_type IN ('clone', 'upload')),
  source_url text,
  source_archive_path text,
  storage_path text NOT NULL,
  requested_ref text,
  default_ref text,
  active_analysis_id uuid,
  state varchar(24) NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'validating', 'acquiring', 'enumerating', 'analyzing',
    'rolling_up', 'ready', 'failed', 'cancelled', 'deleting'
  )),
  progress double precision NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  progress_stage text,
  commit_count bigint NOT NULL DEFAULT 0 CHECK (commit_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  reference_name text NOT NULL,
  reference_oid varchar(64),
  analyzer_version varchar(40) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'queued',
  total_commits bigint NOT NULL DEFAULT 0 CHECK (total_commits >= 0),
  processed_commits bigint NOT NULL DEFAULT 0 CHECK (processed_commits >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE repositories
    ADD CONSTRAINT repositories_active_analysis_fk
    FOREIGN KEY (active_analysis_id) REFERENCES analysis_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS repository_refs (
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('branch', 'tag', 'remote', 'other')),
  target_oid varchar(64) NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, name)
);

CREATE TABLE IF NOT EXISTS author_identities (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, name, email)
);

CREATE TABLE IF NOT EXISTS commits (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  oid varchar(64) NOT NULL,
  parent_oid varchar(64),
  tree_oid varchar(64) NOT NULL,
  raw_author_id uuid NOT NULL REFERENCES author_identities(id),
  committer_at timestamptz NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, oid)
);

CREATE TABLE IF NOT EXISTS analysis_commits (
  analysis_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  commit_id uuid NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  PRIMARY KEY (analysis_id, commit_id),
  UNIQUE (analysis_id, sequence)
);

CREATE TABLE IF NOT EXISTS analysis_author_resolution (
  analysis_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  raw_identity_id uuid NOT NULL REFERENCES author_identities(id) ON DELETE CASCADE,
  resolved_identity_id uuid NOT NULL REFERENCES author_identities(id) ON DELETE CASCADE,
  source varchar(16) NOT NULL CHECK (source IN ('default', 'mailmap')),
  PRIMARY KEY (analysis_id, raw_identity_id)
);

CREATE TABLE IF NOT EXISTS author_groups (
  id uuid PRIMARY KEY,
  analysis_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text,
  is_manual boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS author_group_members (
  analysis_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  resolved_identity_id uuid NOT NULL REFERENCES author_identities(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES author_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (analysis_id, resolved_identity_id)
);

CREATE TABLE IF NOT EXISTS objects (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL CHECK (kind IN ('root', 'directory', 'file')),
  path_bytes bytea NOT NULL,
  display_path text NOT NULL,
  parent_id uuid REFERENCES objects(id) ON DELETE CASCADE,
  depth integer NOT NULL CHECK (depth >= 0),
  binary_observed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, kind, path_bytes)
);

CREATE TABLE IF NOT EXISTS commit_object_metrics (
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_id uuid NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  added bigint NOT NULL CHECK (added >= 0),
  removed bigint NOT NULL CHECK (removed >= 0),
  PRIMARY KEY (commit_id, object_id),
  CHECK (added + removed > 0)
);

CREATE TABLE IF NOT EXISTS daily_object_author_rollups (
  analysis_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  day date NOT NULL,
  object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  raw_author_id uuid NOT NULL REFERENCES author_identities(id) ON DELETE CASCADE,
  added bigint NOT NULL CHECK (added >= 0),
  removed bigint NOT NULL CHECK (removed >= 0),
  modifications bigint NOT NULL CHECK (modifications >= 0),
  PRIMARY KEY (analysis_id, day, object_id, raw_author_id)
);

CREATE TABLE IF NOT EXISTS saved_commit_sets (
  id uuid PRIMARY KEY,
  analysis_id uuid NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_commit_set_members (
  commit_set_id uuid NOT NULL REFERENCES saved_commit_sets(id) ON DELETE CASCADE,
  commit_id uuid NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  PRIMARY KEY (commit_set_id, commit_id)
);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES analysis_runs(id) ON DELETE CASCADE,
  stage varchar(40) NOT NULL,
  progress double precision NOT NULL CHECK (progress >= 0 AND progress <= 1),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_runs_repository_created_idx
  ON analysis_runs (repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS commits_repository_time_idx
  ON commits (repository_id, committer_at, id);
CREATE INDEX IF NOT EXISTS commits_repository_author_time_idx
  ON commits (repository_id, raw_author_id, committer_at);
CREATE INDEX IF NOT EXISTS analysis_commits_sequence_idx
  ON analysis_commits (analysis_id, sequence);
CREATE INDEX IF NOT EXISTS analysis_commits_commit_idx
  ON analysis_commits (commit_id, analysis_id);
CREATE INDEX IF NOT EXISTS objects_parent_display_idx
  ON objects (repository_id, parent_id, display_path);
CREATE INDEX IF NOT EXISTS objects_display_search_idx
  ON objects (repository_id, lower(display_path));
CREATE INDEX IF NOT EXISTS metrics_object_commit_idx
  ON commit_object_metrics (object_id, commit_id) INCLUDE (added, removed);
CREATE INDEX IF NOT EXISTS metrics_repository_commit_idx
  ON commit_object_metrics (repository_id, commit_id);
CREATE INDEX IF NOT EXISTS rollups_analysis_object_day_idx
  ON daily_object_author_rollups (analysis_id, object_id, day);
CREATE INDEX IF NOT EXISTS rollups_analysis_author_day_idx
  ON daily_object_author_rollups (analysis_id, raw_author_id, day);
CREATE INDEX IF NOT EXISTS commit_set_members_commit_idx
  ON saved_commit_set_members (commit_id, commit_set_id);
CREATE INDEX IF NOT EXISTS job_events_repository_id_idx
  ON job_events (repository_id, id);

COMMIT;
