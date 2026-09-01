-- Close the door PostgREST leaves open.
--
-- A managed Postgres (Supabase, and anything else fronting the database with an
-- auto-generated REST API) exposes every table in `public` to whoever holds the
-- project's anon key — and that key is designed to be public. Catchfly never
-- uses it: the functions connect server-side with a connection string, as the
-- table owner.
--
-- Enabling RLS with no policies is therefore exactly right. PostgREST's roles
-- match no policy and are denied everything; the owner bypasses RLS and is
-- unaffected. On a plain self-hosted Postgres with no REST layer this is a
-- harmless no-op, which is why it belongs in the migration rather than in a
-- vendor-specific setup step.
--
-- When Catchfly grows real accounts, the policies that replace this will be
-- written against them — not against an anonymous key.

ALTER TABLE projects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_cases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_results      ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
