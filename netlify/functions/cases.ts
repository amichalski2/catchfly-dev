/**
 * POST /api/projects/:projectId/cases — add one eval case.
 *
 * This is the write behind "create eval from session": the point where a
 * production failure stops being an incident and becomes a test that will fail
 * again if the fix regresses. The case arrives already assembled — the caller
 * saw the session and decided what the expectation should be — so this endpoint
 * validates and stores rather than deriving anything.
 *
 * Key-protected like the run import, and for the same reason: it writes.
 */

import type { EvalCase, ExpectedCallNode } from '@catchfly/core/types.ts';

import { authorizeProjectWrite } from './lib/user-auth.ts';
import { isDatabaseConfigured } from './lib/db.ts';
import { BadJson, BodyTooLarge, json, methodNotAllowed, readJson } from './lib/http.ts';
import { caseExists, saveCase } from './lib/session-store.ts';
import { projectExists, projectIsReadOnly } from './lib/store.ts';

export const config = { path: '/api/projects/:projectId/cases' };

/** A case is a prompt and a handful of expected calls, not a report. */
const MAX_BODY_BYTES = 256 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

type Body = {
  case?: Partial<EvalCase>;
  /** Without this, a colliding caseId is refused rather than silently rewritten. */
  overwrite?: boolean;
};

/** Every node must name a function, at any depth of ordered/unordered nesting. */
function validExpectation(nodes: unknown): nodes is ExpectedCallNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  return nodes.every((node) => {
    if (!node || typeof node !== 'object') return false;
    if ('ordered' in node) return validExpectation((node as { ordered: unknown }).ordered);
    if ('unordered' in node) return validExpectation((node as { unordered: unknown }).unordered);
    return typeof (node as { functionName?: unknown }).functionName === 'string';
  });
}

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
    return json(403, { error: 'The synthetic demo is read-only. Create a measured project to add eval cases.' });
  }

  let body: Body;
  try {
    body = (await readJson(req, MAX_BODY_BYTES)) as Body;
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { error: 'Case is too large.' });
    if (error instanceof BadJson) return json(400, { error: 'Body is not valid JSON.' });
    throw error;
  }

  const input = body.case;
  if (!input || typeof input !== 'object') {
    return json(400, { error: 'Expected a "case" object.' });
  }
  if (typeof input.caseId !== 'string' || !ID_PATTERN.test(input.caseId)) {
    return json(400, { error: 'A "caseId" of letters, digits, dots, dashes or underscores is required.' });
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    return json(400, {
      error: 'A non-empty "prompt" is required — a case without the request it replays cannot be run.',
    });
  }
  if (!validExpectation(input.expectedCall)) {
    return json(400, { error: '"expectedCall" must be a non-empty array of expected calls.' });
  }

  if (!body.overwrite && (await caseExists(projectId, input.caseId))) {
    return json(409, { error: `Case "${input.caseId}" already exists. Pass "overwrite": true to replace it.` });
  }

  const evalCase: EvalCase = {
    caseId: input.caseId,
    name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name : input.prompt,
    prompt: input.prompt,
    expectedCall: input.expectedCall,
  };
  if (typeof input.expectedBehavior === 'string' && input.expectedBehavior.trim() !== '') {
    evalCase.expectedBehavior = input.expectedBehavior;
  }
  if (typeof input.sourceSessionId === 'string' && input.sourceSessionId.trim() !== '') {
    evalCase.sourceSessionId = input.sourceSessionId;
  }

  await saveCase(projectId, evalCase);
  return json(201, { case: evalCase });
}
