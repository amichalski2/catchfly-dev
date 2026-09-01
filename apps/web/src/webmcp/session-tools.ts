/**
 * The production half of the tool surface.
 *
 * Same rule as the eval tools: every one of these is a thin wrapper over the
 * layer the human uses. The reads go through the configured `SessionsSource`,
 * which is the same object the Sessions view reads, so an agent and a reviewer
 * cannot be looking at different numbers. The writes go through the same store
 * actions the UI's buttons call, tagged 'agent'.
 *
 * These are gated on the session registry settling rather than on the dataset:
 * a deployment without a database has no session data at all, and an agent
 * deserves to be told that immediately instead of waiting on a promise that
 * will not resolve.
 */

import { getDb } from '@catchfly/core/db.ts';
import { categoryLabel } from '@catchfly/core/labels.ts';
import { releaseEvidence } from '@catchfly/core/release-evidence.ts';
import { toolEvalProfile, knownToolNames } from '@catchfly/core/schema-diff.ts';
import type { SessionFilters, SessionOutcome } from '@catchfly/core/session-types.ts';
import { isSessionsAvailable, sessionsSource } from '@catchfly/core/sessions-db.ts';
import { FAILURE_CATEGORIES, type FailureCategory } from '@catchfly/core/types.ts';
import {
  deploymentPayload,
  sessionPayload,
  sessionSummaryPayload,
  toolProfilePayload,
  truncated,
} from '@catchfly/webmcp/payloads.ts';
import type { ModelContextTool } from '@catchfly/webmcp/spec.ts';

import { catchflyStore } from '../state/store.ts';
import { asEnum, asOptionalString, asString, SEES_AND_CAN_UNDO, writeResult } from './tools.ts';

const OUTCOMES: Array<SessionOutcome | 'any-failure'> = [
  'completed',
  'failed',
  'abandoned',
  'unknown',
  'any-failure',
];

/** Refuses clearly rather than throwing from inside a fetch that will not happen. */
function source() {
  if (!isSessionsAvailable()) {
    throw new Error(
      'This deployment has no production session data — the eval tools still work. ' +
        'Do not retry; nothing will appear.',
    );
  }
  return sessionsSource();
}

const FILTER_PROPERTIES = {
  deploymentId: { type: 'string', description: 'Restrict to one deployment. See list_deployments.' },
  environment: { type: 'string', description: 'Restrict to one environment, e.g. "production".' },
  outcome: {
    type: 'string',
    enum: OUTCOMES,
    description: 'Task outcome. "any-failure" covers both failed and abandoned sessions.',
  },
  category: {
    type: 'string',
    enum: FAILURE_CATEGORIES,
    description: 'Catchfly\'s classification of why the session failed, where one could be derived.',
  },
  toolCalled: { type: 'string', description: 'Only sessions that called this tool.' },
  search: { type: 'string', description: 'Free text over the captured intent and the tool names called.' },
  from: { type: 'string', description: 'ISO 8601 lower bound on when the session started.' },
  to: { type: 'string', description: 'ISO 8601 upper bound on when the session started.' },
} as const;

function parseSessionFilters(input: Record<string, unknown>): SessionFilters {
  const filters: SessionFilters = {};
  const deploymentId = asOptionalString(input, 'deploymentId');
  if (deploymentId !== undefined) filters.deploymentId = deploymentId;
  const environment = asOptionalString(input, 'environment');
  if (environment !== undefined) filters.environment = environment;
  const outcome = asEnum(input, 'outcome', OUTCOMES);
  if (outcome !== undefined) filters.outcome = outcome;
  const category = asEnum(input, 'category', FAILURE_CATEGORIES as FailureCategory[]);
  if (category !== undefined) filters.category = category;
  const toolCalled = asOptionalString(input, 'toolCalled');
  if (toolCalled !== undefined) filters.toolCalled = toolCalled;
  const search = asOptionalString(input, 'search');
  if (search !== undefined) filters.search = search;
  const from = asOptionalString(input, 'from');
  if (from !== undefined) filters.from = from;
  const to = asOptionalString(input, 'to');
  if (to !== undefined) filters.to = to;
  return filters;
}

/**
 * Whether the developer can see the session this payload describes — the same
 * courtesy the case tools extend, for the same reason: a read answers in the
 * agent's context, which nobody else can see.
 */
function visibility(sessionId: string): { shownToUser: boolean; hint?: string } {
  const state = catchflyStore.getState();
  if (state.selectedSessionId === sessionId && state.view === 'session-detail') {
    return { shownToUser: true };
  }
  return {
    shownToUser: false,
    hint: `The developer is not looking at this session — open_session with sessionId "${sessionId}" puts it on their screen.`,
  };
}

export function buildSessionTools(): ModelContextTool[] {
  return [
    {
      name: 'list_deployments',
      title: 'List deployments',
      description:
        'List the releases of the instrumented app, newest last, each with how much production ' +
        'traffic it served and how much of it failed. Every deployment names the app version — ' +
        'i.e. the tool manifest — that was live, which is the join between production behaviour ' +
        'and a schema change. Start here when asked what changed or when something started.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => ({ deployments: (await source().listDeployments()).map(deploymentPayload) }),
    },

    {
      name: 'search_sessions',
      title: 'Search sessions',
      description:
        'Query production sessions without touching the developer\'s view. Returns one page of ' +
        'summaries — counts, not call bodies — newest first, with a cursor for the next page, ' +
        'the total number of matches, and selectedSessionId when the developer already has one ' +
        'of them open. Use get_session for the calls a session actually made. ' +
        'This is also how to search trajectories: toolCalled narrows to sessions that reached ' +
        'for one tool, category to why they failed, and deploymentId to one release — combine ' +
        'the three to find the traces behind an incident, then open_session to read one.',
      inputSchema: {
        type: 'object',
        properties: {
          ...FILTER_PROPERTIES,
          cursor: { type: 'string', description: 'Continue a previous page. Omit for the first page.' },
          limit: { type: 'integer', description: 'Sessions per page, up to 200. Defaults to 50.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const limit = input.limit === undefined ? undefined : Number(input.limit);
        const page = await source().searchSessions(
          parseSessionFilters(input),
          asOptionalString(input, 'cursor') ?? null,
          limit,
        );
        const state = catchflyStore.getState();
        return {
          ...truncated(page.sessions.map(sessionSummaryPayload)),
          matching: page.total,
          nextCursor: page.nextCursor,
          selectedSessionId: state.view === 'session-detail' ? state.selectedSessionId : null,
        };
      },
    },

    {
      name: 'get_session',
      title: 'Read a session',
      description:
        'Read one production session in full: every tool call in order, with arguments, result, ' +
        'duration and whether the app accepted it, plus the agent\'s own narration when the client ' +
        'forwarded any. Large results are clipped with an explicit marker. Reports whether the ' +
        'developer is currently looking at this session.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'A session id from search_sessions.' } },
        required: ['sessionId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const sessionId = asString(input, 'sessionId');
        const session = await source().getSession(sessionId);
        if (!session) throw new Error(`Unknown session "${sessionId}". Call search_sessions for valid ids.`);
        return { ...sessionPayload(session), ...visibility(sessionId) };
      },
    },

    {
      name: 'get_tool_profile',
      title: 'Read a tool profile',
      description:
        'Everything Catchfly knows about one tool: how often production called it, how often the ' +
        'app rejected the call, p50/p95 duration, the breakdown per deployment, the full history ' +
        'of what its schema declared, and the diff between each pair of versions. This is where a ' +
        'behavioural change is traced back to a description or an argument that changed.',
      inputSchema: {
        type: 'object',
        properties: { toolName: { type: 'string', description: 'A tool name, e.g. from get_session.' } },
        required: ['toolName'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const toolName = asString(input, 'toolName');
        const declared = knownToolNames(getDb());
        const production = await source().getToolProduction(toolName);
        if (!production && !declared.includes(toolName)) {
          throw new Error(
            `No tool "${toolName}" — it is not in any manifest and nothing has called it. ` +
              `Declared tools: ${declared.join(', ')}`,
          );
        }
        return toolProfilePayload(
          production ?? {
            toolName,
            calls: 0,
            errorCalls: 0,
            successRate: 0,
            p50DurationMs: 0,
            p95DurationMs: 0,
            errorTypes: [],
            byDeployment: [],
          },
          toolEvalProfile(getDb(), toolName),
        );
      },
    },

    {
      name: 'compare_deployments',
      title: 'Compare deployments',
      description:
        'What moved between two releases: rateDelta is the production failure-rate change in ' +
        'percentage points; tools lists call volume and execution success on each side with the ' +
        'delta, ordered worst first; categories is the failure-mode mix shift; toolChanges is ' +
        'every tool whose traffic or declared schema changed, with the manifest diff; findings is ' +
        'the evidence chain the Releases view shows. Read the call counts alongside the deltas — ' +
        'a large swing on a handful of calls is not the same finding as a small one on hundreds.',
      inputSchema: {
        type: 'object',
        properties: {
          baselineDeploymentId: { type: 'string' },
          candidateDeploymentId: { type: 'string' },
        },
        required: ['baselineDeploymentId', 'candidateDeploymentId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const baselineId = asString(input, 'baselineDeploymentId');
        const candidateId = asString(input, 'candidateDeploymentId');
        const active = source();
        const deployments = await active.listDeployments();
        for (const id of [baselineId, candidateId]) {
          if (!deployments.some((entry) => entry.id === id)) {
            throw new Error(
              `Unknown deployment "${id}". Known: ${deployments.map((entry) => entry.id).join(', ')}`,
            );
          }
        }

        const comparison = await active.compareDeployments(baselineId, candidateId);
        const db = getDb();
        const evidence = releaseEvidence(
          comparison,
          (appVersionId) => db.versionsById.get(appVersionId)?.toolManifest ?? [],
          categoryLabel,
        );
        return {
          baseline: deploymentPayload(comparison.baseline),
          candidate: deploymentPayload(comparison.candidate),
          rateDelta: Number((evidence.rateDelta * 100).toFixed(2)),
          tools: comparison.tools,
          categories: comparison.categories,
          toolChanges: evidence.toolChanges,
          findings: evidence.findings,
        };
      },
    },

    // --- writes ---------------------------------------------------------

    {
      name: 'set_session_filters',
      title: 'Filter the sessions',
      description:
        'Change the session filters the developer sees, and switch them to the Sessions view. ' +
        'Patch semantics: fields you omit keep their value. Pass reset: true to clear everything ' +
        'first. Use search_sessions instead when you only need to look. Returns the resulting ' +
        'state, including how many sessions are on screen.' + SEES_AND_CAN_UNDO,
      inputSchema: {
        type: 'object',
        properties: {
          ...FILTER_PROPERTIES,
          reset: { type: 'boolean', description: 'Clear the existing filters before applying these.' },
        },
        additionalProperties: false,
      },
      execute: async (input) => {
        catchflyStore
          .getState()
          .setSessionFilters(parseSessionFilters(input), 'agent', { reset: input.reset === true });
        return writeResult();
      },
    },

    {
      name: 'open_session',
      title: 'Open a session',
      description:
        'Put one production session on the developer\'s screen, with its full trace. Also ' +
        'registers the session-scoped tools. Opening the session that is already open changes ' +
        'nothing and reports alreadyOpen: true. Returns the resulting shared state.' + SEES_AND_CAN_UNDO,
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const sessionId = asString(input, 'sessionId');
        // Refuse before navigating: sending the developer to a blank screen is
        // worse than saying the id was wrong.
        const session = await source().getSession(sessionId);
        if (!session) throw new Error(`Unknown session "${sessionId}". Call search_sessions for valid ids.`);
        const state = catchflyStore.getState();
        if (state.selectedSessionId === sessionId && state.view === 'session-detail') {
          return writeResult({ alreadyOpen: true });
        }
        state.openSession(sessionId, 'agent');
        return writeResult();
      },
    },

    {
      name: 'open_tool',
      title: 'Open a tool profile',
      description:
        'Put a tool profile on the developer\'s screen: its production behaviour across ' +
        'deployments and its schema history side by side. This is the view that shows what a ' +
        'release changed about the tool. Returns the resulting shared state.' + SEES_AND_CAN_UNDO,
      inputSchema: {
        type: 'object',
        properties: { toolName: { type: 'string' } },
        required: ['toolName'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const toolName = asString(input, 'toolName');
        const declared = knownToolNames(getDb());
        if (!declared.includes(toolName)) {
          const production = isSessionsAvailable() ? await sessionsSource().getToolProduction(toolName) : null;
          if (!production) {
            throw new Error(`No tool "${toolName}". Declared tools: ${declared.join(', ')}`);
          }
        }
        catchflyStore.getState().openTool(toolName, 'agent');
        return writeResult();
      },
    },
  ];
}
