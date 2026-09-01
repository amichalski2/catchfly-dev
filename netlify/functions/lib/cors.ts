import { sql } from './db.ts';

const ALLOW_HEADERS = 'authorization, content-type, idempotency-key';

export function corsPreflight(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': req.headers.get('origin') ?? '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': ALLOW_HEADERS,
      'access-control-max-age': '86400',
      vary: 'origin',
    },
  });
}

export function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', req.headers.get('origin') ?? '*');
  headers.append('vary', 'origin');
  return new Response(response.body, { status: response.status, headers });
}

export function originAllowed(req: Request, allowedOrigins: string[] | null): boolean {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins || allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

const HOURLY_CAP = Number(process.env.CATCHFLY_INGEST_HOURLY_CAP ?? 100_000);

export async function underHourlyCap(projectId: string): Promise<boolean> {
  const { rows } = await sql().query<{ total: string }>(
    `select coalesce(sum(accepted_count + duplicate_count + rejected_count), 0) as total
       from ingest_batches
      where project_id = $1 and received_at > now() - interval '1 hour'`,
    [projectId],
  );
  return Number(rows[0]?.total ?? 0) < HOURLY_CAP;
}
