-- NULL means any origin: a key proxied through the app's own backend has no
-- browser origin to pin. A key pasted into client code should list its sites.
ALTER TABLE project_api_keys ADD COLUMN IF NOT EXISTS allowed_origins text[];
