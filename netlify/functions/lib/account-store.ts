import { randomBytes } from 'node:crypto';

import type { ProjectApiKey } from '@catchfly/core/product-types.ts';

import { sql, transaction } from './db.ts';
import { createProjectKey, recordAudit } from './product-store.ts';
import { createProject, listProjects, type ProjectSummary } from './store.ts';
import type { UserClaims } from './user-auth.ts';

export type OrgSummary = { id: string; name: string; role: string };

export async function upsertProfile(user: UserClaims): Promise<void> {
  await sql().query(
    `insert into user_profiles (user_id, email)
     values ($1::uuid, $2)
     on conflict (user_id) do update set email = excluded.email, updated_at = now()`,
    [user.userId, user.email],
  );
}

export async function orgsForUser(userId: string): Promise<OrgSummary[]> {
  const { rows } = await sql().query<{ id: string; name: string; role: string }>(
    `select o.id, o.name, m.role
       from org_members m
       join organizations o on o.id = m.org_id
      where m.user_id = $1::uuid
      order by o.created_at`,
    [userId],
  );
  return rows;
}

export async function orgRole(orgId: string, userId: string): Promise<string | null> {
  const { rows } = await sql().query<{ role: string }>(
    'select role from org_members where org_id = $1 and user_id = $2::uuid',
    [orgId, userId],
  );
  return rows[0]?.role ?? null;
}

export async function renameOrg(orgId: string, name: string): Promise<void> {
  await sql().query('update organizations set name = $2 where id = $1', [orgId, name]);
}

export async function listProjectsVisibleTo(userId: string | null): Promise<ProjectSummary[]> {
  const all = await listProjects();
  if (userId === null) {
    const { rows } = await sql().query<{ id: string }>(
      `select id from projects where org_id is null and data_origin = 'synthetic'`,
    );
    const visible = new Set(rows.map((row) => row.id));
    return all.filter((project) => visible.has(project.id));
  }
  const { rows } = await sql().query<{ id: string }>(
    `select id from projects
      where (org_id is null and data_origin = 'synthetic')
         or org_id in (select org_id from org_members where user_id = $1::uuid)`,
    [userId],
  );
  const visible = new Set(rows.map((row) => row.id));
  return all.filter((project) => visible.has(project.id));
}

export type Provisioned = {
  org: OrgSummary;
  project: ProjectSummary;
  environmentId: string;
  ingestKey?: ProjectApiKey & { secret: string };
  created: boolean;
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

export async function provisionFirstProject(
  user: UserClaims,
  options: { allowedOrigins?: string[] } = {},
): Promise<Provisioned> {
  const orgs = await orgsForUser(user.userId);
  if (orgs.length > 0) {
    const { rows } = await sql().query<{ id: string }>(
      'select id from projects where org_id = $1 order by created_at limit 1',
      [orgs[0].id],
    );
    if (rows[0]) {
      const existing = (await listProjects()).find((project) => project.id === rows[0].id)!;
      return { org: orgs[0], project: existing, environmentId: 'production', created: false };
    }
  }

  const localPart = slug(user.email.split('@')[0] ?? '');
  const orgId = `org_${randomBytes(6).toString('hex')}`;
  const orgName = `${localPart}'s workspace`;
  const projectId = `${localPart}-${randomBytes(3).toString('hex')}`;

  const org =
    orgs[0] ??
    (await transaction(async (client) => {
      await client.query(
        'insert into organizations (id, name, created_by) values ($1, $2, $3::uuid)',
        [orgId, orgName, user.userId],
      );
      await client.query(
        `insert into org_members (org_id, user_id, role) values ($1, $2::uuid, 'owner')`,
        [orgId, user.userId],
      );
      return { id: orgId, name: orgName, role: 'owner' };
    }));

  const project = await createProject({ id: projectId, name: `${localPart} app`, orgId: org.id });

  const { key, secret } = await createProjectKey(projectId, {
    environmentId: 'production',
    name: 'Onboarding ingest key',
    scopes: ['ingest'],
    ...(options.allowedOrigins?.length ? { allowedOrigins: options.allowedOrigins } : {}),
  });
  await recordAudit(projectId, 'system', user.userId, 'project.provisioned', org.id, {
    email: user.email,
  });

  return {
    org,
    project: { ...project, id: projectId },
    environmentId: 'production',
    ingestKey: { ...key, secret },
    created: true,
  };
}
