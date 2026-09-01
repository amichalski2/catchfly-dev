/**
 * Catchfly data model.
 *
 * Shapes marked "Chrome-compatible" mirror the JSON report emitted by the
 * Chrome WebMCP Evals CLI (GoogleChromeLabs/webmcp-tools), so a report can be
 * mapped into Catchfly without a schema migration:
 *
 *   { config: { backend, model, chromeChannel, ... },
 *     results: { results: TestResult[], testCount, passCount, failCount, errorCount } }
 *
 * What Catchfly adds on top: app versions, cross-run history, failure
 * categories, latency and cost.
 */

/** Chrome-compatible: a single tool invocation made by the model. */
export type ToolCall = {
  functionName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

/** Chrome-compatible: one tool as declared by the evaluated app (schema.json). */
export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
};

/** Chrome-compatible: one expected call inside an eval definition. */
export type ExpectedFunctionCall = {
  functionName: string;
  /** Omitted/null means "any arguments accepted". May contain matchers ($lte, $pattern, ...). */
  arguments?: Record<string, unknown> | null;
  /** When set, the tool's execution result is checked against this value/constraint. */
  result?: unknown;
  /** Optional calls contribute neither a pass nor a fail when skipped. */
  optional?: boolean;
};

/** Chrome-compatible: expected calls may be grouped as ordered or unordered. */
export type ExpectedCallNode =
  | ExpectedFunctionCall
  | { ordered: ExpectedCallNode[] }
  | { unordered: ExpectedCallNode[] };

/** Chrome-compatible: one step of the model's trajectory. */
export type TrajectoryStep = {
  text?: string;
  reasoningText?: string;
  toolCalls?: ToolCall[];
  toolResults?: unknown[];
};

/** Chrome-compatible: three-state outcome (not a boolean). */
export type Outcome = 'pass' | 'fail' | 'error';

/**
 * Catchfly's own classification of *why* a case failed.
 *
 * Five categories are inferred by comparing expected calls against actual ones.
 * `error` is different: it mirrors Chrome's `outcome: 'error'` — the attempt
 * never completed — and says nothing about the model's choices.
 */
export type FailureCategory =
  | 'tool-selection'
  | 'structured-output'
  | 'argument-errors'
  | 'hallucinated-tool'
  | 'sequencing'
  | 'error';

export const FAILURE_CATEGORIES: FailureCategory[] = [
  'tool-selection',
  'structured-output',
  'argument-errors',
  'hallucinated-tool',
  'sequencing',
  'error',
];

/** Whether a row came from an observed runner or a deterministic demo world. */
export type DataOrigin = 'measured' | 'synthetic';

/** A project may intentionally combine a measured eval pilot with synthetic traffic. */
export type ProjectDataOrigin = DataOrigin | 'mixed';

/** An eval case definition, shared across every run that executed it. */
export type EvalCase = {
  caseId: string;
  /** Chrome identifies a case by `name` (falling back to the first user message). */
  name: string;
  /** First user message of `messages`. */
  prompt: string;
  expectedCall: ExpectedCallNode[];
  expectedBehavior?: string;
  /**
   * Set when the case was minted from a production session rather than written
   * by hand — the provenance that makes "this test exists because it broke in
   * production" readable from the data.
   */
  sourceSessionId?: string;
};

/** One attempt at one case within one run (Chrome: TestResult + runIndex). */
export type CaseResult = {
  caseId: string;
  /** Repetition index, 1-based (Chrome CLI: `--runs`). */
  runIndex: number;
  outcome: Outcome;
  /** Derived by Catchfly, absent when the attempt passed. */
  category?: FailureCategory;
  actualCalls: ToolCall[];
  trajectory: TrajectoryStep[];
  /** Catchfly extras — absent on imported Chrome reports. */
  latencyMs?: number;
  costUsd?: number;
  failureReason?: string;
};

/** Chrome-compatible counters, plus Catchfly's derived metrics. */
export type RunMetrics = {
  testCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  successRate: number;
  avgLatencyMs?: number;
  totalCostUsd?: number;
};

/** One eval run = one Chrome report = one app version x one model. */
export type EvalRun = {
  id: string;
  appVersionId: string;
  model: string;
  /** Chrome config.backend: vercel | gemini | ollama. */
  backend?: string;
  /** ISO 8601. */
  timestamp: string;
  metrics: RunMetrics;
  results: CaseResult[];
  /** Omitted for legacy imports; the database treats those as measured. */
  dataOrigin?: DataOrigin;
};

/** A version of the evaluated app — i.e. one tool manifest. Not present in Chrome reports. */
export type AppVersion = {
  id: string;
  label: string;
  /** What the app exposed to agents at this version. Chrome: schema.json. */
  toolManifest: ToolSchema[];
  releasedAt: string;
  note?: string;
};

export type Project = {
  id: string;
  name: string;
  appVersions: AppVersion[];
  /** Visible provenance: a demo world must never present itself as observed traffic. */
  dataOrigin?: ProjectDataOrigin;
  generatorVersion?: string;
  generatorSeed?: string;
};

/** The whole persisted dataset for one project. */
export type CatchflyDataset = {
  project: Project;
  cases: EvalCase[];
  runs: EvalRun[];
};

/** The compact form used in paginated eval lists; trajectories stay on detail routes. */
export type EvalRunSummary = Omit<EvalRun, 'results'>;

export type EvalRunFilters = {
  appVersionId?: string;
  model?: string;
  from?: string;
  to?: string;
};

export type EvalRunPage = {
  runs: EvalRunSummary[];
  total: number;
  nextCursor: string | null;
};

export type EvalResultFilters = {
  outcome?: Outcome;
  category?: FailureCategory;
  caseId?: string;
};

export type EvalResultPage = {
  /** Bounded by the page size; detail is complete so existing analytics stay exact. */
  results: CaseResult[];
  total: number;
  nextCursor: string | null;
};

export type EvalCasePage = {
  cases: EvalCase[];
  total: number;
  nextCursor: string | null;
};

/** Fast, server-aggregated read model for large synthetic investigation worlds. */
export type IncidentTimelinePoint = {
  appVersionId: string;
  appVersionLabel: string;
  releasedAt: string;
  deploymentId: string | null;
  scenarioId: string;
  scenarioLabel: string;
  kind: 'control' | 'regression' | 'decoy' | 'recovery';
  evalSuccessRate: number;
  evalAttempts: number;
  productionFailureRate: number;
  productionSessions: number;
  avgToolLatencyMs: number;
};

export type IncidentSummary = {
  id: string;
  title: string;
  kind: 'regression' | 'decoy' | 'recovery';
  tools: string[];
  failureCategory: FailureCategory | null;
  occurrences: number;
  evalSuccessRateDelta: number;
  productionFailureRateDelta: number;
  latencyMultiplier: number;
  modelAgreement: number;
  modelCount: number;
  baselineVersionId: string;
  candidateVersionId: string;
  baselineRunId: string;
  candidateRunId: string;
  model: string;
  summary: string;
};

export type IncidentOverview = {
  projectId: string;
  incidentPatterns: number;
  affectedTools: number;
  evalAttempts: number;
  productionSessions: number;
  timeline: IncidentTimelinePoint[];
  incidents: IncidentSummary[];
};

/** First payload for a large project: dimensions only, never every attempt. */
export type EvalBootstrap = {
  project: Project;
  models: string[];
  runCount: number;
  caseCount: number;
};
