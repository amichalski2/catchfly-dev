-- Large demo worlds remain ordinary Catchfly projects, but their read paths
-- cannot assume a few hundred rows. These indexes match the filters exposed by
-- the paginated API and keep the raw rows as the source of truth.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS data_origin text NOT NULL DEFAULT 'measured'
    CHECK (data_origin IN ('measured', 'synthetic', 'mixed')),
  ADD COLUMN IF NOT EXISTS generator_version text,
  ADD COLUMN IF NOT EXISTS generator_seed text;

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS data_origin text NOT NULL DEFAULT 'measured'
    CHECK (data_origin IN ('measured', 'synthetic'));

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS data_origin text NOT NULL DEFAULT 'measured'
    CHECK (data_origin IN ('measured', 'synthetic'));

-- Keyset order after the most common session filters.
CREATE INDEX IF NOT EXISTS sessions_by_outcome_time
  ON sessions (project_id, outcome, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS sessions_by_category_time
  ON sessions (project_id, failure_category, started_at DESC, id DESC)
  WHERE failure_category IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_by_model_time
  ON sessions (project_id, model, started_at DESC, id DESC)
  WHERE model IS NOT NULL;

-- `toolCalled` uses EXISTS and tool profiles group the same relation.
CREATE INDEX IF NOT EXISTS session_calls_by_tool_session
  ON session_tool_calls (project_id, tool_name, session_id);

-- Eval list/detail endpoints never need to scan another run's attempts.
CREATE INDEX IF NOT EXISTS case_results_by_run_outcome
  ON case_results (project_id, run_id, outcome, category, case_id, run_index);

CREATE INDEX IF NOT EXISTS case_results_by_case_outcome
  ON case_results (project_id, case_id, outcome, run_id, run_index);
