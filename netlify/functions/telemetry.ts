import type { TelemetryEvent } from '@catchfly/core/product-types.ts';

import { authorizeProjectKey } from './lib/auth.ts';
import { corsPreflight, originAllowed, underHourlyCap, withCors } from './lib/cors.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { ingestTelemetry, parseTelemetryEvent, type EventRejection } from './lib/telemetry.ts';
import { projectExists, projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/v1/projects/:projectId/events' };
const MAX_EVENTS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (req.method === 'OPTIONS') return corsPreflight(req);
  return withCors(req, await ingest(req, context));
}

async function ingest(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId } = context.params;
  if (!(await projectExists(projectId))) return json(404, { error: `Unknown project "${projectId}".` });
  if (await projectIsReadOnly(projectId)) return json(403, { error: 'The synthetic demo is read-only.' });
  const grant = await authorizeProjectKey(req, projectId, 'ingest');
  if ('status' in grant) return json(grant.status, { error: grant.error });
  if (!originAllowed(req, grant.allowedOrigins)) {
    return json(403, { error: 'This key does not accept events from this origin.' });
  }
  if (!(await underHourlyCap(projectId))) {
    return json(429, { error: 'Hourly ingest cap reached for this project. Try again later.' });
  }

  let body: Record<string, unknown>;
  try {
    body = (await readJson(req, MAX_BODY_BYTES)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { error: error.message });
    if (error instanceof BadJson) return json(400, { error: error.message });
    throw error;
  }
  if (typeof body.environmentId !== 'string' || body.environmentId === '') {
    return json(400, { error: 'environmentId is required.' });
  }
  if (grant.environmentId !== '*' && grant.environmentId !== body.environmentId) {
    return json(403, { error: `This key is scoped to environment "${grant.environmentId}".` });
  }
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS) {
    return json(400, { error: `events must contain between 1 and ${MAX_EVENTS} items.` });
  }
  const events: TelemetryEvent[] = [];
  const rejected: EventRejection[] = [];
  body.events.forEach((value, index) => {
    const parsed = parseTelemetryEvent(value, index);
    if ('error' in parsed) rejected.push(parsed);
    else events.push(parsed);
  });
  if (events.length === 0) return json(422, { error: 'Every event was rejected.', rejected });
  try {
    const result = await ingestTelemetry({
      projectId,
      environmentId: body.environmentId,
      actorKeyId: grant.id,
      idempotencyKey: req.headers.get('idempotency-key') ?? undefined,
      events,
      rejected,
    });
    return json(202, result);
  } catch (error) {
    if ((error as Error).message.startsWith('Unknown environment')) return json(404, { error: (error as Error).message });
    throw error;
  }
}
