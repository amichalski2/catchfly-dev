-- Environments backfilled from pre-telemetry deployments need the same default
-- policy as environments created through the product API.

INSERT INTO data_policies (project_id, environment_id)
SELECT project_id, id FROM environments
ON CONFLICT (project_id, environment_id) DO NOTHING;
