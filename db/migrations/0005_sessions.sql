-- Production sessions: the half of Catchfly that watches real agents.
--
-- The event model in the PRD is a stream (session.started, tool.called,
-- tool.failed, task.completed). What lands here is that stream already folded
-- into rows, because the two shapes are good at different jobs: a log is the
-- right thing to ingest, a row is the right thing to answer "show me this
-- session" from. Column names still follow the event payload, so the telemetry
-- SDK can post what it already has.
--
-- Same rules as 0001: project_id leads every key, composite foreign keys carry
-- it, enum-ish columns get a CHECK, documents that are not queried relationally
-- stay JSONB, and every access path the product actually uses gets an index.

CREATE TABLE IF NOT EXISTS deployments (
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id             text NOT NULL,
  -- Which tool manifest was live. This is the join that lets a failure be
  -- traced from production traffic to the schema change that caused it.
  app_version_id text NOT NULL,
  environment    text NOT NULL,
  deployed_at    timestamptz NOT NULL,
  commit_sha     text,
  note           text,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, app_version_id)
    REFERENCES app_versions(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  project_id       text NOT NULL,
  id               text NOT NULL,
  deployment_id    text NOT NULL,
  environment      text NOT NULL,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  -- Agent identity is optional on purpose: the browser does not always say, and
  -- Catchfly must not imply certainty it does not have.
  agent            text,
  model            text,
  intent           text,
  -- Task success, not execution success. A session every one of whose calls
  -- returned 200 can still have failed the person who asked.
  outcome          text NOT NULL CHECK (outcome IN ('completed', 'failed', 'abandoned', 'unknown')),
  -- Why it failed, in the same vocabulary as eval failures. Nullable and often
  -- null: deriving it needs a known expected behaviour, which real ingested
  -- traffic does not carry. Absent means uncategorised, never "no failure".
  failure_category text CHECK (failure_category IN (
                     'tool-selection', 'structured-output', 'argument-errors',
                     'hallucinated-tool', 'sequencing', 'error')),
  failure_tool     text,
  -- TrajectoryStep[]: the agent's own narration, when the client forwarded it.
  transcript       jsonb,
  metadata         jsonb,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, deployment_id)
    REFERENCES deployments(project_id, id) ON DELETE CASCADE
);

-- Sessions are the first thing in Catchfly that does not fit in one response.
-- They are read newest-first with a keyset cursor, and this index is that order.
CREATE INDEX IF NOT EXISTS sessions_by_time
  ON sessions (project_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS sessions_by_deployment
  ON sessions (project_id, deployment_id);

CREATE TABLE IF NOT EXISTS session_tool_calls (
  project_id          text NOT NULL,
  session_id          text NOT NULL,
  -- Call order within the session. Timestamps can tie; this cannot.
  ordinal             int  NOT NULL,
  ts                  timestamptz NOT NULL,
  tool_name           text NOT NULL,
  tool_schema_version text,
  arguments           jsonb,
  result              jsonb,
  -- Execution success: did the tool run? See sessions.outcome for the other one.
  status              text NOT NULL CHECK (status IN ('success', 'error')),
  duration_ms         double precision NOT NULL,
  error_type          text,
  error_message       text,
  PRIMARY KEY (project_id, session_id, ordinal),
  FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, id) ON DELETE CASCADE
);

-- A tool profile aggregates every call of one tool across the whole project,
-- which without this index is a project-wide scan.
CREATE INDEX IF NOT EXISTS session_calls_by_tool
  ON session_tool_calls (project_id, tool_name);

-- Provenance for cases minted from a session: what makes "this test exists
-- because it broke in production" readable from the data rather than from a
-- commit message.
ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS source_session_id text;

-- Same reasoning as 0004: RLS on, no policies. Every new table needs this or it
-- is reachable through an auto-generated REST API with a public key.
ALTER TABLE deployments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_tool_calls ENABLE ROW LEVEL SECURITY;
