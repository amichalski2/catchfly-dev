/**
 * POST /api/projects/:projectId/runs — import a Chrome WebMCP Evals report.
 *
 * The adapter runs here rather than in the browser, so the CLI, the dashboard
 * and any future client all produce identical rows from identical input. The
 * run id comes from the same `runIdFor` the client uses, so an optimistic merge
 * in the UI and the stored row agree on identity.
 */

// By path rather than by package name, for the reason given in lib/telemetry.ts:
// these are the adapter's runtime exports, and resolving them through the
// package's exports map is what the deployed bundler failed to do.
import { adaptChromeReport, ImportError, type ChromeReport } from '../../packages/eval-adapters/src/chrome.ts';
import { runIdFor } from '../../packages/eval-adapters/src/merge.ts';

import { authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { forgetIncidentOverview } from './lib/incident-store.ts';
import { projectExists, projectIsReadOnly, saveRun } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/runs' };

/** A 500-case report with trajectories is large; beyond this, use the CLI. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export default async function handler(
  req: Request,
  context: { params: { projectId: string } },
): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  if (!isDatabaseConfigured()) {
    return json(503, { error: 'No database is configured for this deployment.' });
  }

  const { projectId } = context.params;
  const grant = await authorizeProjectWrite(req, projectId, 'evals:write');
  if (grant) return json(grant.status, { error: grant.error });
  if (!(await projectExists(projectId))) {
    return json(404, { error: `Unknown project "${projectId}".` });
  }
  if (await projectIsReadOnly(projectId)) {
    return json(403, { error: 'The synthetic demo is read-only. Create a measured project to import runs.' });
  }

  let body: unknown;
  try {
    body = await readJson(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { error: error.message });
    if (error instanceof BadJson) return json(400, { error: error.message });
    throw error;
  }

  const input = body as {
    report?: unknown;
    appVersion?: { id?: unknown; label?: unknown; note?: unknown; releasedAt?: unknown };
  };
  const version = input.appVersion ?? {};
  if (typeof version.id !== 'string' || !ID_PATTERN.test(version.id)) {
    return json(400, {
      error: '"appVersion.id" is required and must be letters, digits, dots, hyphens or underscores.',
    });
  }
  if (version.label !== undefined && typeof version.label !== 'string') {
    return json(400, { error: '"appVersion.label" must be a string.' });
  }
  if (!input.report || typeof input.report !== 'object') {
    return json(400, { error: '"report" must be a Chrome WebMCP Evals report object.' });
  }

  const report = input.report as ChromeReport;
  const model = (report.config as { model?: unknown } | undefined)?.model;
  const modelName = typeof model === 'string' && model.length > 0 ? model : 'unknown-model';

  let adapted;
  try {
    adapted = adaptChromeReport(report, {
      appVersionId: version.id,
      runId: runIdFor(version.id, modelName),
      // The report carries no clock, so the moment it arrived is the honest one.
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // An ImportError is the adapter explaining what is wrong with the file;
    // pass it through rather than flattening it into "bad request".
    if (error instanceof ImportError) return json(422, { error: error.message });
    throw error;
  }

  await saveRun(projectId, {
    version: {
      id: version.id,
      label: typeof version.label === 'string' && version.label ? version.label : version.id,
      releasedAt:
        typeof version.releasedAt === 'string' ? version.releasedAt : new Date().toISOString(),
      ...(typeof version.note === 'string' ? { note: version.note } : {}),
      toolManifest: adapted.toolManifest,
    },
    cases: adapted.cases,
    run: adapted.run,
  });
  forgetIncidentOverview(projectId);

  // Metrics only: the caller already has the results it just uploaded.
  return json(201, {
    run: {
      id: adapted.run.id,
      appVersionId: adapted.run.appVersionId,
      model: adapted.run.model,
      timestamp: adapted.run.timestamp,
      metrics: adapted.run.metrics,
    },
    cases: adapted.cases.length,
  });
}
