import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { ApiKeyScope } from '@catchfly/core/product-types.ts';

import { authorizeProjectKey, checkWriteKey, type AuthFailure } from './auth.ts';
import { isDatabaseConfigured, sql } from './db.ts';

const NO_DATABASE: AuthFailure = {
  status: 503,
  error: 'No database is configured for this deployment.',
};

export type UserClaims = { userId: string; email: string };

export type OrgRole = 'owner' | 'admin' | 'member';

export type AuthMode = 'none' | 'supabase';

export class AuthConfigurationError extends Error {}

export function authMode(): AuthMode {
  const configured = process.env.CATCHFLY_AUTH_MODE;
  if (configured !== 'none' && configured !== 'supabase') {
    throw new AuthConfigurationError(
      'CATCHFLY_AUTH_MODE must be explicitly set to "none" or "supabase".',
    );
  }
  if (configured === 'supabase' && !process.env.SUPABASE_URL) {
    throw new AuthConfigurationError('SUPABASE_URL is required when CATCHFLY_AUTH_MODE=supabase.');
  }
  return configured;
}

export function supabaseAuthEnabled(): boolean {
  return authMode() === 'supabase';
}

let jwks: JWTVerifyGetKey | null = null;

function remoteJwks(): JWTVerifyGetKey | null {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  jwks ??= createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return jwks;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  // Project keys travel in the same header; only a JWT has three dot-separated parts.
  return token.split('.').length === 3 && !token.startsWith('cfly_') ? token : null;
}

export async function userFromRequest(req: Request): Promise<UserClaims | null> {
  const token = bearerToken(req);
  if (!token || !supabaseAuthEnabled()) return null;

  const issuer = `${process.env.SUPABASE_URL}/auth/v1`;
  const options = { issuer, audience: 'authenticated' };

  const keys = remoteJwks();
  if (keys) {
    try {
      const { payload } = await jwtVerify(token, keys, options);
      if (typeof payload.sub === 'string') {
        return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
      }
    } catch {
      // Fail closed here, but let the HS256 secret below have its turn.
    }
  }

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (secret) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), options);
      if (typeof payload.sub === 'string') {
        return { userId: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
      }
    } catch {
      return null;
    }
  }
  return null;
}

type ProjectAccess = {
  worldReadable: boolean;
  role: OrgRole | null;
};

async function projectAccess(projectId: string, userId: string | null): Promise<ProjectAccess | null> {
  const { rows } = await sql().query<{
    org_id: string | null;
    data_origin: string;
    role: OrgRole | null;
  }>(
    `select p.org_id, p.data_origin, m.role
       from projects p
       left join org_members m on m.org_id = p.org_id and m.user_id = $2::uuid
      where p.id = $1`,
    [projectId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    worldReadable: row.org_id === null && row.data_origin === 'synthetic',
    role: row.role,
  };
}

const adminKeySupplied = (req: Request): boolean => checkWriteKey(req) === null;

export async function authorizeProjectRead(
  req: Request,
  projectId: string,
): Promise<AuthFailure | null> {
  if (!supabaseAuthEnabled()) return null;
  if (adminKeySupplied(req)) return null;
  if (!isDatabaseConfigured()) return NO_DATABASE;

  const user = await userFromRequest(req);
  const access = await projectAccess(projectId, user?.userId ?? null);
  if (access?.worldReadable || access?.role) return null;
  return { status: 401, error: 'Sign in to read this project.' };
}

export async function authorizeProjectAdmin(
  req: Request,
  projectId: string,
): Promise<UserClaims | AuthFailure> {
  if (adminKeySupplied(req)) return { userId: 'admin-key', email: '' };
  if (!supabaseAuthEnabled()) {
    return { status: 401, error: 'Missing or invalid x-catchfly-key header.' };
  }

  if (!isDatabaseConfigured()) return NO_DATABASE;
  const user = await userFromRequest(req);
  if (!user) return { status: 401, error: 'Sign in to change this project.' };
  const access = await projectAccess(projectId, user.userId);
  if (access?.role === 'owner' || access?.role === 'admin') return user;
  return { status: 401, error: 'Only an organization owner or admin can change this project.' };
}

export async function authorizeProjectWrite(
  req: Request,
  projectId: string,
  keyScope: ApiKeyScope = 'admin',
): Promise<AuthFailure | null> {
  const admin = await authorizeProjectAdmin(req, projectId);
  if (!('status' in admin)) return null;
  if (admin.status === 503) return admin;

  const grant = await authorizeProjectKey(req, projectId, keyScope);
  if (!('status' in grant)) return null;
  return {
    status: 401,
    error: `Sign in as an organization owner or admin, or supply a project key with the "${keyScope}" scope.`,
  };
}

export async function authorizeUser(req: Request): Promise<UserClaims | AuthFailure> {
  if (adminKeySupplied(req)) return { userId: 'admin-key', email: '' };
  if (!supabaseAuthEnabled()) return { userId: 'anonymous', email: '' };
  const user = await userFromRequest(req);
  if (!user) return { status: 401, error: 'Sign in to use this endpoint.' };
  return user;
}

export async function authorizeUserDenied(req: Request): Promise<AuthFailure | null> {
  const user = await authorizeUser(req);
  return 'status' in user ? user : null;
}
