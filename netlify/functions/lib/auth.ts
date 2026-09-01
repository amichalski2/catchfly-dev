/**
 * Write protection for the ingestion endpoints.
 *
 * A shared secret, not accounts: this is the smallest thing that stops a public
 * URL from being a public write endpoint, and it is deliberately not pretending
 * to be more. Real accounts, per-project keys and rotation are the next step;
 * until then reads stay open (the data is a public dashboard) and every write
 * needs the key.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { ApiKeyScope, ProjectApiKey } from '@catchfly/core/product-types.ts';

import { sql } from './db.ts';

const HEADER = 'x-catchfly-key';

export type AuthFailure = { status: 401 | 503; error: string };

export function checkWriteKey(req: Request): AuthFailure | null {
  const expected = process.env.CATCHFLY_ADMIN_KEY;
  if (!expected) {
    return {
      status: 503,
      error:
        'Administration is not configured on this deployment. Set CATCHFLY_ADMIN_KEY to accept writes.',
    };
  }
  const provided = req.headers.get(HEADER);
  if (!provided || !timingSafeEqual(provided, expected)) {
    return { status: 401, error: `Missing or invalid ${HEADER} header.` };
  }
  return null;
}

/** Constant time in the length-equal case, so the key cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const keyHash = (value: string): string => createHash('sha256').update(value).digest('hex');

function suppliedKey(req: Request): string | null {
  const bearer = req.headers.get('authorization');
  if (bearer?.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();
  return req.headers.get(HEADER);
}

export type ProjectKeyGrant = {
  id: string;
  projectId: string;
  environmentId: string;
  scopes: ApiKeyScope[];
  allowedOrigins: string[] | null;
};

/** Authorizes a project-scoped key. The deployment-wide key remains a bootstrap fallback. */
export async function authorizeProjectKey(
  req: Request,
  projectId: string,
  requiredScope: ApiKeyScope,
): Promise<ProjectKeyGrant | AuthFailure> {
  const provided = suppliedKey(req);
  if (!provided) return { status: 401, error: 'Missing Authorization: Bearer <project key>.' };

  const adminKey = process.env.CATCHFLY_ADMIN_KEY;
  if (adminKey && timingSafeEqual(provided, adminKey)) {
    return {
      id: 'admin-bootstrap-key',
      projectId,
      environmentId: '*',
      scopes: ['admin', 'ingest', 'evals:write'],
      allowedOrigins: null,
    };
  }

  const digest = keyHash(provided);
  const { rows } = await sql().query<{
    id: string;
    environment_id: string;
    scopes: ApiKeyScope[];
    allowed_origins: string[] | null;
  }>(
    `select id, environment_id, scopes, allowed_origins
       from project_api_keys
      where project_id = $1 and key_hash = $2
        and revoked_at is null
        and (expires_at is null or expires_at > now())`,
    [projectId, digest],
  );
  const row = rows[0];
  if (!row || (!row.scopes.includes(requiredScope) && !row.scopes.includes('admin'))) {
    return { status: 401, error: 'Invalid, expired or insufficiently scoped project key.' };
  }
  await sql().query(
    'update project_api_keys set last_used_at = now() where project_id = $1 and id = $2',
    [projectId, row.id],
  );
  return {
    id: row.id,
    projectId,
    environmentId: row.environment_id,
    scopes: row.scopes,
    allowedOrigins: row.allowed_origins,
  };
}

/** Creates a secret once; callers persist only its SHA-256 digest. */
export function mintProjectKey(projectId: string): {
  id: string;
  secret: string;
  prefix: string;
  hash: string;
} {
  const id = randomUUID();
  const prefix = `cfly_${projectId.slice(0, 12)}`;
  const secret = `${prefix}.${randomBytes(32).toString('base64url')}`;
  return { id, secret, prefix, hash: keyHash(secret) };
}

export function apiKeyPayload(row: {
  id: string;
  project_id: string;
  environment_id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  allowed_origins?: string[] | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}): ProjectApiKey {
  return {
    id: row.id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: row.scopes,
    ...(row.allowed_origins?.length ? { allowedOrigins: row.allowed_origins } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at.toISOString() } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
  };
}
