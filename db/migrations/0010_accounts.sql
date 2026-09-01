-- user_profiles deliberately has no FK into any auth vendor's schema: it is a
-- mirror upserted from verified JWT claims, so the same SQL runs against
-- Supabase and a plain Postgres self-host.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      uuid PRIMARY KEY,
  email        text NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS projects_by_org ON projects (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_members_by_user ON org_members (user_id);

-- Same discipline as 0004: RLS on with no policies denies the PostgREST anon
-- role; the app connects as the table owner and enforces membership in guards.
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
