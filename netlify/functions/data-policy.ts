import type { RedactionRule } from '@catchfly/core/product-types.ts';

import { authorizeProjectRead, authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { getDataPolicy, saveDataPolicy } from './lib/product-store.ts';
import { projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/environments/:environmentId/policy' };
const ACTIONS = ['remove', 'mask', 'hash', 'truncate'];

function validRules(value: unknown): value is RedactionRule[] {
  return Array.isArray(value) && value.every((rule) => {
    if (!rule || typeof rule !== 'object') return false;
    const item = rule as Partial<RedactionRule>;
    return typeof item.path === 'string' && item.path.startsWith('payload.') &&
      typeof item.action === 'string' && ACTIONS.includes(item.action) &&
      (item.action !== 'truncate' || (Number.isInteger(item.maxLength) && (item.maxLength ?? 0) > 0));
  });
}

export default async function handler(
  req: Request,
  context: { params: { projectId: string; environmentId: string } },
): Promise<Response> {
  if (!isDatabaseConfigured()) return json(503, { error: 'No database is configured for this deployment.' });
  const { projectId, environmentId } = context.params;
  if (req.method === 'GET') {
    const readDenied = await authorizeProjectRead(req, projectId);
    if (readDenied) return json(readDenied.status, { error: readDenied.error });
    const policy = await getDataPolicy(projectId, environmentId);
    return policy ? json(200, { policy }) : json(404, { error: 'Unknown environment or data policy.' });
  }
  if (req.method !== 'PUT') return methodNotAllowed('GET or PUT');
  if (await projectIsReadOnly(projectId)) return json(403, { error: 'The synthetic demo is read-only.' });
  const writeDenied = await authorizeProjectWrite(req, projectId);
  if (writeDenied) return json(writeDenied.status, { error: writeDenied.error });
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req, 64 * 1024)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BodyTooLarge || error instanceof BadJson) return json(400, { error: error.message });
    throw error;
  }
  if (!validRules(body.redactionRules)) return json(400, { error: 'redactionRules are invalid.' });
  const samplingRate = Number(body.samplingRate);
  const retentionDays = Number(body.retentionDays);
  if (!Number.isFinite(samplingRate) || samplingRate < 0 || samplingRate > 1) return json(400, { error: 'samplingRate must be between 0 and 1.' });
  if (!Number.isInteger(retentionDays) || retentionDays < 1) return json(400, { error: 'retentionDays must be a positive integer.' });
  return json(200, { policy: await saveDataPolicy(projectId, environmentId, { redactionRules: body.redactionRules, samplingRate, retentionDays }) });
}
