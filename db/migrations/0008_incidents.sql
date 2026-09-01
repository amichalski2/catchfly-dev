-- Human-managed incidents promoted from deterministic findings.

CREATE TABLE IF NOT EXISTS incidents (
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id          text NOT NULL,
  finding_id  text,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  severity    text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  owner       text,
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (project_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_finding
  ON incidents (project_id, finding_id)
  WHERE finding_id IS NOT NULL AND status <> 'resolved';

CREATE TABLE IF NOT EXISTS incident_notes (
  project_id  text NOT NULL,
  incident_id text NOT NULL,
  id          bigint GENERATED ALWAYS AS IDENTITY,
  author      text,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, incident_id, id),
  FOREIGN KEY (project_id, incident_id)
    REFERENCES incidents(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incidents_by_status_time
  ON incidents (project_id, status, updated_at DESC);

ALTER TABLE incidents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_notes ENABLE ROW LEVEL SECURITY;
