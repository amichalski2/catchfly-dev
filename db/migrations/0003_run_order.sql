-- Run order is data too.
--
-- The dashboard boots into a comparison chosen from the first two runs of the
-- first model, so the order runs arrive in decides what a visitor sees first.
-- Timestamps alone do not reproduce it: a dataset assembled from several
-- reports is grouped by version and model, not by clock.

ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS ordinal int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS eval_runs_by_order ON eval_runs (project_id, ordinal);
