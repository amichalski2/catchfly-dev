-- Product foundation: project environments, scoped ingest keys, data policy,
-- append-only telemetry and an audit trail. The existing sessions tables stay
-- the read model used by the dashboard; telemetry_events is the durable input.

CREATE TABLE IF NOT EXISTS environments (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id         text NOT NULL,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('development', 'staging', 'production')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id)
);

-- Preserve environments already present in generated and measured traffic.
INSERT INTO environments (project_id, id, name, kind)
SELECT DISTINCT project_id,
       lower(regexp_replace(environment, '[^a-zA-Z0-9]+', '-', 'g')),
       environment,
       CASE WHEN lower(environment) IN ('development', 'staging', 'production')
            THEN lower(environment)
            ELSE 'production'
       END
  FROM deployments
ON CONFLICT (project_id, id) DO NOTHING;

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS environment_id text;
UPDATE deployments
   SET environment_id = lower(regexp_replace(environment, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE environment_id IS NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS environment_id text;
UPDATE sessions s
   SET environment_id = d.environment_id
  FROM deployments d
 WHERE d.project_id = s.project_id
   AND d.id = s.deployment_id
   AND s.environment_id IS NULL;

CREATE INDEX IF NOT EXISTS deployments_by_environment
  ON deployments (project_id, environment_id, deployed_at DESC);
CREATE INDEX IF NOT EXISTS sessions_by_environment_time
  ON sessions (project_id, environment_id, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS project_api_keys (
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id             text NOT NULL,
  environment_id text NOT NULL,
  name           text NOT NULL,
  key_prefix     text NOT NULL,
  key_hash       text NOT NULL,
  scopes         text[] NOT NULL DEFAULT ARRAY['ingest']::text[],
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  PRIMARY KEY (project_id, id),
  UNIQUE (key_hash),
  FOREIGN KEY (project_id, environment_id)
    REFERENCES environments(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_api_keys_by_prefix
  ON project_api_keys (project_id, key_prefix)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS data_policies (
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id text NOT NULL,
  redaction_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  sampling_rate  double precision NOT NULL DEFAULT 1.0
    CHECK (sampling_rate >= 0 AND sampling_rate <= 1),
  retention_days int NOT NULL DEFAULT 30 CHECK (retention_days >= 1),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, environment_id),
  FOREIGN KEY (project_id, environment_id)
    REFERENCES environments(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingest_batches (
  project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id              text NOT NULL,
  environment_id  text NOT NULL,
  idempotency_key text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  accepted_count  int NOT NULL DEFAULT 0,
  duplicate_count int NOT NULL DEFAULT 0,
  sampled_count   int NOT NULL DEFAULT 0,
  rejected_count  int NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, idempotency_key),
  FOREIGN KEY (project_id, environment_id)
    REFERENCES environments(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  project_id     text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id       text NOT NULL,
  environment_id text NOT NULL,
  batch_id       text NOT NULL,
  session_id     text NOT NULL,
  sequence       int NOT NULL CHECK (sequence >= 0),
  event_type     text NOT NULL CHECK (event_type IN (
                   'session.started', 'tool.called', 'tool.completed', 'tool.failed',
                   'task.completed', 'task.failed', 'session.abandoned',
                   'deployment.registered', 'manifest.observed'
                 )),
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (project_id, event_id),
  UNIQUE (project_id, session_id, sequence, event_type),
  FOREIGN KEY (project_id, environment_id)
    REFERENCES environments(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, batch_id)
    REFERENCES ingest_batches(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS telemetry_events_by_session
  ON telemetry_events (project_id, session_id, sequence, occurred_at);
CREATE INDEX IF NOT EXISTS telemetry_events_by_received
  ON telemetry_events (project_id, environment_id, received_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('system', 'admin', 'api-key', 'agent')),
  actor_id   text,
  action     text NOT NULL,
  target     text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_by_project_time
  ON audit_log (project_id, created_at DESC);

ALTER TABLE environments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_policies    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_batches   ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log        ENABLE ROW LEVEL SECURITY;
