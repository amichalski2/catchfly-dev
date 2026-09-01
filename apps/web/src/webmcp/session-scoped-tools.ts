/**
 * Session-scoped tools — registered only while a session is open.
 *
 * The mirror of case-tools.ts, and scoped for the same reason: these take no
 * sessionId, so what the agent inspects is by construction what the developer
 * is looking at.
 *
 * `create_eval_from_session` is the one tool in Catchfly that changes something
 * durable. It is deliberately here, on the scoped surface, rather than as a
 * global tool taking an id: minting a permanent test is not a thing to do to a
 * session nobody has looked at.
 */

import { getDb } from '@catchfly/core/db.ts';
import { buildCaseFromSession, MintError } from '@catchfly/core/eval-from-session.ts';
import type { Session } from '@catchfly/core/session-types.ts';
import { isSessionsAvailable, sessionsSource } from '@catchfly/core/sessions-db.ts';
import { sessionPayload } from '@catchfly/webmcp/payloads.ts';
import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

import { ApiError, createCase, readStoredEvalKey } from '../data/api.ts';
import { invalidateProject } from '../data/load.ts';
import { catchflyStore } from '../state/store.ts';
import { asOptionalString, describeSharedState } from './tools.ts';

async function selectedSession(): Promise<Session> {
  const sessionId = catchflyStore.getState().selectedSessionId;
  if (!sessionId) throw new Error('No session is selected any more — call open_session first.');
  if (!isSessionsAvailable()) throw new Error('This deployment has no production session data.');
  const session = await sessionsSource().getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" is no longer readable.`);
  return session;
}

export function buildSessionScopedTools(): ModelContextTool[] {
  return [
    {
      name: 'inspect_selected_session',
      title: 'Inspect the open session',
      description:
        'Prefer this over get_session while a session is open: it takes no sessionId and always ' +
        'describes the session the developer is actually looking at, so it cannot drift from ' +
        'their screen. Returns the full trace — every call with arguments, result, duration and ' +
        'status, plus any narration the client forwarded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ({ ...sessionPayload(await selectedSession()), shownToUser: true }),
    },

    {
      name: 'create_eval_from_session',
      title: 'Create an eval case',
      description:
        'Prepare or, after explicit developer approval, create a permanent eval case from the open session. ' +
        'Call first without confirmed to review the exact draft. Only pass confirmed: true after the ' +
        'developer approves that draft. ' +
        'The saved case makes this failure checked on every ' +
        'future run. By default the expectation is the calls that succeeded, with their ' +
        'arguments, plus the rejected call by name only — asserting the arguments that failed ' +
        'would mint a test for the bug. Pass correctedCalls when you know what should have ' +
        'happened instead. Requires a CI key to be stored in the browser; if it is not, ask the ' +
        'developer to create one in Project settings → Connection rather than retrying.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable case name. Defaults to one naming the session.' },
          prompt: {
            type: 'string',
            description:
              'The request to replay. Required only when the session captured no user intent.',
          },
          expectedBehavior: {
            type: 'string',
            description: 'What a correct run should achieve. Defaults to a description of the observed failure.',
          },
          correctedCalls: {
            type: 'array',
            description:
              'The call sequence that should have happened, replacing the derived expectation. ' +
              'Omit arguments on a call to accept any.',
            items: {
              type: 'object',
              properties: {
                functionName: { type: 'string' },
                arguments: { type: 'object', description: 'Exact arguments to require. Omit for any.' },
              },
              required: ['functionName'],
              additionalProperties: false,
            },
          },
          overwrite: { type: 'boolean', description: 'Replace an existing case with the same id.' },
          confirmed: {
            type: 'boolean',
            description: 'Set true only after the developer explicitly approves the returned draft.',
          },
        },
        additionalProperties: false,
      },
      annotations: { destructiveHint: true },
      execute: async (input) => {
        const session = await selectedSession();
        const corrected = Array.isArray(input.correctedCalls)
          ? (input.correctedCalls as Array<{ functionName: string; arguments?: Record<string, unknown> }>)
          : undefined;

        let evalCase;
        try {
          evalCase = buildCaseFromSession(session, {
            taken: getDb().dataset.cases.map((entry) => entry.caseId),
            name: asOptionalString(input, 'name'),
            prompt: asOptionalString(input, 'prompt'),
            expectedBehavior: asOptionalString(input, 'expectedBehavior'),
            correctedCalls: corrected,
          });
        } catch (error) {
          // A mint that cannot be made is the agent's to fix by supplying what
          // is missing, so say which field that is.
          if (error instanceof MintError) throw new Error(error.message);
          throw error;
        }

        if (input.confirmed !== true) {
          return {
            confirmationRequired: true,
            draft: evalCase,
            warning:
              'Nothing has been saved. Show this draft to the developer and call again with ' +
              'confirmed: true only after they explicitly approve it.',
          };
        }

        const key = readStoredEvalKey();
        if (!key) {
          throw new Error(
            'No eval key is stored in this browser, so the approved case cannot be saved. Ask the ' +
              'developer to create a CI key in Project settings → Connection, ' +
              'then call this again with confirmed: true.',
          );
        }

        const projectId = catchflyStore.getState().projectId;
        try {
          const saved = await createCase({
            projectId,
            evalCase,
            key,
            overwrite: input.overwrite === true,
          });
          // The stored dataset now holds a case the cached one does not.
          invalidateProject(projectId);
          catchflyStore
            .getState()
            .noteImport(`Created eval case ${saved.caseId} from session ${session.id}`, 'agent');
          return {
            created: saved,
            hint:
              `The case is stored. It will appear in the case table after the dataset reloads; ` +
              `open_case with caseId "${saved.caseId}" puts it on the developer's screen.`,
            state: describeSharedState(),
          };
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            throw new Error(
              'The stored CI key was refused. Ask the developer to create a new one in Project settings → Connection.',
            );
          }
          if (error instanceof ApiError && error.status === 409) {
            throw new Error(
              `A case named "${evalCase.caseId}" already exists. Pass overwrite: true to replace it.`,
            );
          }
          throw error;
        }
      },
    },

    {
      name: 'close_session',
      title: 'Close the session',
      description:
        'Close the session trace and return the developer to the session list. The ' +
        'session-scoped tools disappear until a session is opened again. Returns the resulting state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        catchflyStore.getState().closeSession('agent');
        return describeSharedState();
      },
    },
  ];
}
