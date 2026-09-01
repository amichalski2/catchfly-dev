-- Case order is data.
--
-- A suite is authored in a deliberate order and the Cases table shows it that
-- way. Reading rows back alphabetically would quietly reorder the dashboard, so
-- the position is stored rather than inferred.

ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS ordinal int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS eval_cases_by_order ON eval_cases (project_id, ordinal);
