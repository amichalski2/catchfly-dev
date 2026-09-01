-- Catchfly schema, v1.
--
-- Relational where Catchfly aggregates (projects, versions, runs, results) and
-- JSONB where it stores documents it does not yet query relationally
-- (trajectories, tool calls, expectations, manifests). That split keeps the
-- rollups cheap without pretending to know how trajectories will be queried.
--
-- Plain PostgreSQL: no vendor extensions, so a self-hosted Catchfly runs the
-- same DDL as the hosted one.

CREATE TABLE IF NOT EXISTS projects (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_versions (
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id            text NOT NULL,
  label         text NOT NULL,
  released_at   timestamptz NOT NULL,
  note          text,
  -- ToolSchema[]: what the app exposed to agents at this version.
  tool_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS eval_cases (
  project_id        text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  case_id           text NOT NULL,
  name              text NOT NULL,
  prompt            text NOT NULL,
  -- ExpectedCallNode[]: ordered/unordered groups, matchers and all.
  expected_call     jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_behavior text,
  PRIMARY KEY (project_id, case_id)
);

CREATE TABLE IF NOT EXISTS eval_runs (
  project_id     text NOT NULL,
  id             text NOT NULL,
  app_version_id text NOT NULL,
  model          text NOT NULL,
  backend        text,
  ts             timestamptz NOT NULL,
  -- RunMetrics verbatim; latency and cost are absent on imported reports.
  metrics        jsonb NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, app_version_id)
    REFERENCES app_versions(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS case_results (
  project_id     text NOT NULL,
  run_id         text NOT NULL,
  case_id        text NOT NULL,
  -- Repetition index, 1-based (the Chrome CLI's --runs).
  run_index      int  NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('pass', 'fail', 'error')),
  category       text CHECK (category IN (
                   'tool-selection', 'structured-output', 'argument-errors',
                   'hallucinated-tool', 'sequencing', 'error')),
  latency_ms     double precision,
  cost_usd       double precision,
  failure_reason text,
  actual_calls   jsonb NOT NULL DEFAULT '[]'::jsonb,
  trajectory     jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (project_id, run_id, case_id, run_index),
  FOREIGN KEY (project_id, run_id)
    REFERENCES eval_runs(project_id, id) ON DELETE CASCADE
);

-- Reading one case across every run is the case-detail view and the
-- compare_trajectories tool; without this it is a full scan of the project.
CREATE INDEX IF NOT EXISTS case_results_by_case
  ON case_results (project_id, case_id);
