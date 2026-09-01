/**
 * Production telemetry model — the half of Catchfly that watches real agents.
 *
 * The eval model in types.ts answers "how does the app score on a suite?".
 * This one answers "what did agents actually do on the deployed site?". They
 * meet in two places on purpose: both hang off `AppVersion` (a deployment
 * serves one tool manifest), and both classify failures with the same
 * `FailureCategory` vocabulary, so a production failure and an eval failure can
 * be named with one word.
 *
 * Field names follow the `ToolCallEvent` payload in the PRD (§18) rather than
 * the Chrome report, because the eventual telemetry SDK emits that shape. Kept
 * out of types.ts so the Chrome-compatible block stays a faithful mirror of the
 * report format.
 *
 * The event types the PRD lists (§17: session.started, tool.called, ...) are
 * materialized here into rows rather than stored as a log. A log is the right
 * shape for ingestion; a row is the right shape for a page that has to answer
 * "show me this session" without folding a stream first.
 */

import type { DataOrigin, FailureCategory, ToolSchema, TrajectoryStep } from './types.ts';

/**
 * One release of the instrumented app. Sessions attach to a deployment;
 * a deployment names the tool manifest agents saw, which is what makes
 * "the failure started at this deploy" answerable.
 */
export type Deployment = {
  id: string;
  /** The manifest agents saw. Ties production traffic to the eval-side AppVersion. */
  appVersionId: string;
  /** Free-form: 'production', 'staging', ... Catchfly does not enumerate these. */
  environment: string;
  /** ISO 8601. */
  deployedAt: string;
  commitSha?: string;
  note?: string;
};

/** One tool invocation inside a production session — a materialized PRD §18 ToolCallEvent. */
export type SessionToolCall = {
  /** ISO 8601. */
  timestamp: string;
  toolName: string;
  /** The manifest version this call was made against, when the client reported it. */
  toolSchemaVersion?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  /** Did the *tool* execute? Not whether the agent's task succeeded — see SessionOutcome. */
  status: 'success' | 'error';
  durationMs: number;
  errorType?: string;
  errorMessage?: string;
};

/**
 * Did the *agent* accomplish the user's goal? The PRD (§17) is emphatic that
 * this must never be conflated with execution success: every tool call can
 * return 200 and the session can still have failed the person.
 *
 * `unknown` is the honest default — most apps cannot judge task success.
 */
export type SessionOutcome = 'completed' | 'failed' | 'abandoned' | 'unknown';

export type Session = {
  id: string;
  deploymentId: string;
  environment: string;
  /** ISO 8601. */
  startedAt: string;
  endedAt?: string;
  /** Agent identity when the browser reported it. Absent means unknown, never "none". */
  agent?: string;
  model?: string;
  /** What the person asked for, when the app captured it. */
  intent?: string;
  outcome: SessionOutcome;
  /** Present on generated traffic so the UI and an agent can name its provenance. */
  dataOrigin?: DataOrigin;
  /**
   * Why the session failed, in the same vocabulary as eval failures.
   *
   * Only derivable where the expected behaviour is known — which in practice
   * means seeded or replayed traffic. Absent on real ingested sessions, and the
   * UI must read that as "uncategorized", not as "no failure".
   */
  failureCategory?: FailureCategory;
  /** The tool the failure is attributed to, when attributable. */
  failureTool?: string;
  toolCalls: SessionToolCall[];
  /** The agent's own narration, when the client forwarded it. */
  transcript?: TrajectoryStep[];
  metadata?: Record<string, unknown>;
};

/** A session as it appears in a list: counts instead of call bodies. */
export type SessionSummary = {
  id: string;
  deploymentId: string;
  appVersionId: string;
  environment: string;
  startedAt: string;
  agent?: string;
  model?: string;
  intent?: string;
  outcome: SessionOutcome;
  failureCategory?: FailureCategory;
  failureTool?: string;
  toolCallCount: number;
  errorCallCount: number;
  totalDurationMs: number;
};

export type SessionFilters = {
  deploymentId?: string;
  environment?: string;
  /** 'any-failure' matches both a failed task and an abandoned one. */
  outcome?: SessionOutcome | 'any-failure';
  category?: FailureCategory;
  toolCalled?: string;
  /** Free text over intent and tool names. */
  search?: string;
  /** ISO 8601 bounds on startedAt, inclusive. */
  from?: string;
  to?: string;
};

/**
 * One page of sessions. Sessions are the first artefact in Catchfly that does
 * not fit in one response, so this is the first paginated read.
 */
export type SessionPage = {
  sessions: SessionSummary[];
  /** Total matching the filters, so the UI can say "N of M" rather than "N so far". */
  total: number;
  /** Opaque keyset cursor; null when the last page has been served. */
  nextCursor: string | null;
};

export type DeploymentRollup = Deployment & {
  sessionCount: number;
  failedCount: number;
  toolCallCount: number;
  errorCallCount: number;
};

/** The production half of a tool profile (PRD §12.3). */
export type ToolProduction = {
  toolName: string;
  calls: number;
  errorCalls: number;
  /** Execution success: calls that returned without an error. */
  successRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  errorTypes: Array<{ errorType: string; count: number }>;
  byDeployment: Array<{
    deploymentId: string;
    appVersionId: string;
    calls: number;
    errorCalls: number;
    successRate: number;
  }>;
};

/** What changed about one tool between two manifests. */
export type ToolSchemaDiff = {
  descriptionChanged: boolean;
  before?: string;
  after?: string;
  addedProps: string[];
  removedProps: string[];
  /** Present in both manifests but not deep-equal — a retyped or re-documented argument. */
  changedProps: string[];
};

/** The eval half of a tool profile: schema history plus how cases touching the tool score. */
export type ToolEvalProfile = {
  toolName: string;
  schemaByVersion: Array<{ appVersionId: string; label: string; schema: ToolSchema | null }>;
  /** Diffs of adjacent versions, in release order. */
  schemaDiffs: Array<{ fromVersionId: string; toVersionId: string; diff: ToolSchemaDiff }>;
  /** Cases whose expectations name this tool. */
  caseIds: string[];
  passRateByVersion: Array<{ appVersionId: string; passes: number; attempts: number }>;
};

/** Per-tool movement between two deployments — the "what changed?" query, production-side. */
export type DeploymentComparison = {
  baseline: DeploymentRollup;
  candidate: DeploymentRollup;
  tools: Array<{
    toolName: string;
    baselineCalls: number;
    candidateCalls: number;
    baselineSuccessRate: number;
    candidateSuccessRate: number;
    /** Candidate minus baseline. Negative means the tool got worse. */
    successRateDelta: number;
  }>;
  categories: Array<{ category: FailureCategory; baseline: number; candidate: number; delta: number }>;
};
