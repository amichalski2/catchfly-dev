/**
 * Generates the deterministic dataset the smoke suite runs against.
 *
 * This is test data, not product data: neutral ids, no narrative, small enough
 * to read. It never ships in the app bundle. The product's own datasets are the
 * the canonical Devpost investigation world and whatever a user imports.
 *
 * What it deliberately covers, because the smoke suite asserts on all of it:
 *   - three runs on one model, so baseline -> candidate -> fixed comparisons work
 *   - a second model, so the model axis is non-trivial
 *   - runs with and without latency/cost, since imported Chrome reports carry
 *     neither and every consumer must survive that
 *   - all six failure categories, produced by real behaviour rather than by
 *     assigning a label — `categorize()` derives them here exactly as it does
 *     for an imported report
 *   - regressed, pre-existing, fixed and flaky cases
 *   - ordered, unordered, matcher-bearing and result-bearing expectations
 *   - a tool added in the last version, so manifest deltas are non-empty
 *
 * Run with: npm run testdata
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { categorize } from '@catchfly/core/categorize.ts';
import { createDb, setDb } from '@catchfly/core/db.ts';
import type {
  AppVersion,
  CaseResult,
  CatchflyDataset,
  EvalCase,
  EvalRun,
  Outcome,
  ToolCall,
  ToolSchema,
  TrajectoryStep,
} from '@catchfly/core/types.ts';
import {
  TEST_PROJECT_ID,
  TEST_RUN_BASELINE,
  TEST_RUN_CANDIDATE,
  TEST_RUN_FIXED,
  TEST_RUN_OTHER_MODEL,
} from './test-io.ts';
import { toChromeReport } from './to-chrome-report.ts';

const REPEATS = 2;

// --- deterministic jitter ----------------------------------------------

/** Mulberry32 — a seeded PRNG, so regenerating produces an identical file. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- tool manifests ----------------------------------------------------

const tool = (name: string, description: string, properties: Record<string, unknown>): ToolSchema => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false },
});

const ALPHA = (description: string) =>
  tool('tool_alpha', description, { query: { type: 'string' }, limit: { type: 'number' } });
const BETA = tool('tool_beta', 'Take the item found by tool_alpha and record it.', {
  id: { type: 'string' },
});
const GAMMA = (description: string) => tool('tool_gamma', description, { id: { type: 'string' } });
const DELTA = tool('tool_delta', 'Remove a recorded item.', { id: { type: 'string' } });
const EPSILON = tool('tool_epsilon', 'Summarise everything recorded so far.', {});

const VERSIONS: AppVersion[] = [
  {
    id: 'app-v1',
    label: 'app-v1',
    releasedAt: '2026-01-05T00:00:00.000Z',
    note: 'Baseline manifest.',
    toolManifest: [
      ALPHA('Search the catalogue for items matching a text query.'),
      BETA,
      GAMMA('Fetch one known item by its id.'),
      DELTA,
    ],
  },
  {
    id: 'app-v2',
    label: 'app-v2',
    releasedAt: '2026-02-05T00:00:00.000Z',
    note: 'Descriptions shortened — alpha and gamma now overlap semantically.',
    toolManifest: [ALPHA('Find items.'), BETA, GAMMA('Find an item.'), DELTA],
  },
  {
    id: 'app-v3',
    label: 'app-v3',
    releasedAt: '2026-03-05T00:00:00.000Z',
    note: 'Descriptions restored, plus a new summary tool.',
    toolManifest: [
      ALPHA('Search the catalogue for items matching a text query.'),
      BETA,
      GAMMA('Fetch one known item by its id.'),
      DELTA,
      EPSILON,
    ],
  },
];

// --- case archetypes ---------------------------------------------------

type Archetype = 'single' | 'ordered-pair' | 'unordered-pair' | 'with-result' | 'with-matcher';

type CasePlan = {
  archetype: Archetype;
  /** Behaviour per run, in run order: a, b, c, d. */
  behaviour: [Behaviour, Behaviour, Behaviour, Behaviour];
  /** When set, repeat 2 passes even though repeat 1 followed `behaviour`. */
  flakyIn?: string[];
};

type Behaviour =
  | 'correct'
  | 'wrong-tool'
  | 'bad-args'
  | 'hallucinate'
  | 'out-of-order'
  | 'bad-output'
  | 'crash';

/**
 * The outcome matrix. Read a row as: what the model did in run a, b, c, d.
 * Chosen so the candidate exhibits every failure category, the fixed run clears
 * most of them, and a few failures pre-date the candidate (so "regression" and
 * "failure" stay distinguishable).
 */
const PLANS: CasePlan[] = [
  { archetype: 'single', behaviour: ['correct', 'wrong-tool', 'correct', 'correct'] },
  { archetype: 'single', behaviour: ['correct', 'wrong-tool', 'wrong-tool', 'wrong-tool'] },
  { archetype: 'single', behaviour: ['correct', 'bad-args', 'correct', 'bad-args'], flakyIn: ['run-b'] },
  { archetype: 'single', behaviour: ['wrong-tool', 'wrong-tool', 'correct', 'wrong-tool'] },
  { archetype: 'single', behaviour: ['correct', 'correct', 'correct', 'correct'] },
  { archetype: 'ordered-pair', behaviour: ['correct', 'out-of-order', 'correct', 'correct'] },
  {
    archetype: 'ordered-pair',
    behaviour: ['correct', 'out-of-order', 'out-of-order', 'correct'],
    flakyIn: ['run-b'],
  },
  { archetype: 'ordered-pair', behaviour: ['correct', 'correct', 'correct', 'wrong-tool'] },
  { archetype: 'ordered-pair', behaviour: ['wrong-tool', 'correct', 'correct', 'correct'] },
  { archetype: 'ordered-pair', behaviour: ['correct', 'crash', 'correct', 'correct'] },
  { archetype: 'unordered-pair', behaviour: ['correct', 'hallucinate', 'correct', 'correct'] },
  {
    archetype: 'unordered-pair',
    behaviour: ['correct', 'hallucinate', 'hallucinate', 'correct'],
    flakyIn: ['run-b'],
  },
  { archetype: 'unordered-pair', behaviour: ['correct', 'correct', 'correct', 'correct'] },
  { archetype: 'unordered-pair', behaviour: ['correct', 'bad-args', 'correct', 'bad-args'] },
  { archetype: 'with-result', behaviour: ['correct', 'bad-output', 'correct', 'correct'] },
  { archetype: 'with-result', behaviour: ['correct', 'bad-output', 'bad-output', 'bad-output'] },
  { archetype: 'with-result', behaviour: ['correct', 'correct', 'correct', 'correct'] },
  { archetype: 'with-matcher', behaviour: ['correct', 'bad-args', 'correct', 'correct'] },
  { archetype: 'with-matcher', behaviour: ['correct', 'crash', 'correct', 'crash'] },
  { archetype: 'with-matcher', behaviour: ['correct', 'correct', 'correct', 'correct'] },
];

const NAMES: Record<Archetype, string> = {
  single: 'search for one item',
  'ordered-pair': 'search then record',
  'unordered-pair': 'record and remove',
  'with-result': 'fetch and check the payload',
  'with-matcher': 'search within a bounded limit',
};

function caseId(index: number): string {
  return `case-${String(index + 1).padStart(2, '0')}`;
}

function buildCase(index: number, plan: CasePlan): EvalCase {
  const id = caseId(index);
  const query = `item-${index + 1}`;
  const base = {
    caseId: id,
    name: `${NAMES[plan.archetype]} (${id})`,
    prompt: `Please ${NAMES[plan.archetype]} for ${query}.`,
  };

  switch (plan.archetype) {
    case 'single':
      return { ...base, expectedCall: [{ functionName: 'tool_alpha', arguments: { query } }] };
    case 'ordered-pair':
      return {
        ...base,
        expectedCall: [
          { ordered: [{ functionName: 'tool_alpha', arguments: { query } }, { functionName: 'tool_beta' }] },
        ],
      };
    case 'unordered-pair':
      return {
        ...base,
        expectedCall: [
          { unordered: [{ functionName: 'tool_beta' }, { functionName: 'tool_delta' }] },
        ],
      };
    case 'with-result':
      return {
        ...base,
        expectedCall: [{ functionName: 'tool_gamma', arguments: { id: query }, result: { found: true } }],
        expectedBehavior: 'The item is returned with found: true.',
      };
    case 'with-matcher':
      return {
        ...base,
        expectedCall: [{ functionName: 'tool_alpha', arguments: { query, limit: { $lte: 5 } } }],
      };
  }
}

/** The calls a correct attempt makes, in order. */
function correctCalls(index: number): ToolCall[] {
  const query = `item-${index + 1}`;
  switch (PLANS[index].archetype) {
    case 'single':
      return [{ functionName: 'tool_alpha', args: { query }, result: { matches: 3 } }];
    case 'ordered-pair':
      return [
        { functionName: 'tool_alpha', args: { query }, result: { matches: 3 } },
        { functionName: 'tool_beta', args: { id: query }, result: { recorded: true } },
      ];
    case 'unordered-pair':
      return [
        { functionName: 'tool_beta', args: { id: query }, result: { recorded: true } },
        { functionName: 'tool_delta', args: { id: query }, result: { removed: true } },
      ];
    case 'with-result':
      return [{ functionName: 'tool_gamma', args: { id: query }, result: { found: true } }];
    case 'with-matcher':
      return [{ functionName: 'tool_alpha', args: { query, limit: 3 }, result: { matches: 3 } }];
  }
  return [];
}

/** Applies a behaviour to the correct calls, returning what the model "did". */
function callsFor(behaviour: Behaviour, index: number): ToolCall[] {
  const correct = correctCalls(index);
  switch (behaviour) {
    case 'correct':
    case 'bad-output':
      return correct;
    case 'crash':
      return [];
    case 'wrong-tool':
      // Reaches for the semantically overlapping tool instead.
      return [{ ...correct[0], functionName: 'tool_gamma', result: { found: false } }];
    case 'bad-args':
      return correct.map((call, position) =>
        position === 0 ? { ...call, args: { ...call.args, query: 'wrong-value', limit: 99 } } : call,
      );
    case 'hallucinate':
      return [{ functionName: 'tool_omega', args: { id: `item-${index + 1}` }, result: null }];
    case 'out-of-order':
      return [...correct].reverse();
  }
}

function outcomeFor(behaviour: Behaviour): Outcome {
  if (behaviour === 'correct') return 'pass';
  if (behaviour === 'crash') return 'error';
  return 'fail';
}

function trajectoryFor(calls: ToolCall[], behaviour: Behaviour): TrajectoryStep[] {
  if (behaviour === 'crash') {
    return [{ reasoningText: 'The tool call never returned.', toolCalls: [], toolResults: [] }];
  }
  return calls.map((call) => ({
    reasoningText: `Calling ${call.functionName}.`,
    toolCalls: [call],
    toolResults: [call.result],
  }));
}

const REASONS: Partial<Record<Behaviour, string>> = {
  'wrong-tool': 'Called tool_gamma instead of the expected tool.',
  'bad-args': 'Arguments did not satisfy the expectation.',
  hallucinate: 'Called tool_omega, which the app never exposed.',
  'out-of-order': 'Made the expected calls in the wrong order.',
  'bad-output': 'Made the right calls but returned an unusable answer.',
  crash: 'The attempt timed out.',
};

// --- run assembly ------------------------------------------------------

type RunPlan = {
  id: string;
  appVersionId: string;
  model: string;
  timestamp: string;
  /** Imported Chrome reports carry no timings; one run here mirrors that. */
  measured: boolean;
  column: 0 | 1 | 2 | 3;
};

const RUNS: RunPlan[] = [
  {
    id: TEST_RUN_BASELINE,
    appVersionId: 'app-v1',
    model: 'model-a',
    timestamp: '2026-01-06T10:00:00.000Z',
    measured: true,
    column: 0,
  },
  {
    id: TEST_RUN_CANDIDATE,
    appVersionId: 'app-v2',
    model: 'model-a',
    timestamp: '2026-02-06T10:00:00.000Z',
    measured: true,
    column: 1,
  },
  {
    id: TEST_RUN_FIXED,
    appVersionId: 'app-v3',
    model: 'model-a',
    timestamp: '2026-03-06T10:00:00.000Z',
    measured: false,
    column: 2,
  },
  {
    id: TEST_RUN_OTHER_MODEL,
    appVersionId: 'app-v2',
    model: 'model-b',
    timestamp: '2026-02-06T12:00:00.000Z',
    measured: true,
    column: 3,
  },
];

const cases = PLANS.map((plan, index) => buildCase(index, plan));

function buildRun(plan: RunPlan): EvalRun {
  const random = rng(plan.id.split('').reduce((sum, char) => sum + char.charCodeAt(0), 7));
  const knownTools = VERSIONS.find((version) => version.id === plan.appVersionId)!.toolManifest.map(
    (entry) => entry.name,
  );

  const results: CaseResult[] = [];
  for (const [index, casePlan] of PLANS.entries()) {
    const evalCase = cases[index];
    for (let runIndex = 1; runIndex <= REPEATS; runIndex += 1) {
      const flaky = casePlan.flakyIn?.includes(plan.id) === true && runIndex === REPEATS;
      const behaviour = flaky ? 'correct' : casePlan.behaviour[plan.column];
      const actualCalls = callsFor(behaviour, index);
      const outcome = outcomeFor(behaviour);
      const category = categorize({
        expectedCall: evalCase.expectedCall,
        actualCalls,
        outcome,
        knownTools,
      });

      const result: CaseResult = {
        caseId: evalCase.caseId,
        runIndex,
        outcome,
        actualCalls,
        trajectory: trajectoryFor(actualCalls, behaviour),
      };
      if (category) result.category = category;
      if (outcome !== 'pass' && REASONS[behaviour]) result.failureReason = REASONS[behaviour];
      if (plan.measured) {
        const penalty = outcome === 'error' ? 4 : outcome === 'fail' ? 1.2 : 1;
        result.latencyMs = Math.round((120 + random() * 180) * penalty);
        result.costUsd = Number((actualCalls.length * 0.0004 + 0.0002).toFixed(6));
      }
      results.push(result);
    }
  }

  const passCount = results.filter((result) => result.outcome === 'pass').length;
  const errorCount = results.filter((result) => result.outcome === 'error').length;
  const metrics: EvalRun['metrics'] = {
    testCount: results.length,
    passCount,
    failCount: results.length - passCount - errorCount,
    errorCount,
    successRate: passCount / results.length,
  };
  if (plan.measured) {
    metrics.avgLatencyMs = Math.round(
      results.reduce((sum, result) => sum + (result.latencyMs ?? 0), 0) / results.length,
    );
    metrics.totalCostUsd = Number(
      results.reduce((sum, result) => sum + (result.costUsd ?? 0), 0).toFixed(4),
    );
  }

  return {
    id: plan.id,
    appVersionId: plan.appVersionId,
    model: plan.model,
    backend: 'test',
    timestamp: plan.timestamp,
    metrics,
    results,
  };
}

const dataset: CatchflyDataset = {
  project: { id: TEST_PROJECT_ID, name: 'Test Project', appVersions: VERSIONS },
  cases,
  runs: RUNS.map(buildRun),
};

// --- self-checks -------------------------------------------------------
//
// The suite depends on these properties. Assert them here so a bad edit to the
// matrix fails at generation rather than as a confusing smoke failure later.

const db = setDb(createDb(dataset));
const problems: string[] = [];

const candidate = db.runsById.get(TEST_RUN_CANDIDATE)!;
const categoriesSeen = new Set(candidate.results.map((result) => result.category).filter(Boolean));
for (const expected of [
  'tool-selection',
  'structured-output',
  'argument-errors',
  'hallucinated-tool',
  'sequencing',
  'error',
]) {
  if (!categoriesSeen.has(expected as never)) problems.push(`candidate never produces "${expected}"`);
}

if (db.repeats !== REPEATS) problems.push(`repeats is ${db.repeats}, expected ${REPEATS}`);
if (db.models[0] !== 'model-a') problems.push('model-a must be the first model, for defaultComparison');
if (db.runsById.get(TEST_RUN_FIXED)!.metrics.avgLatencyMs !== undefined) {
  problems.push('the fixed run must carry no latency, to exercise the unmeasured path');
}
if (db.runsById.get(TEST_RUN_BASELINE)!.metrics.avgLatencyMs === undefined) {
  problems.push('the baseline run must carry latency');
}
const v3 = db.versionsById.get('app-v3')!.toolManifest.map((entry) => entry.name);
if (!v3.includes('tool_epsilon')) problems.push('app-v3 must add a tool, for manifest deltas');

if (problems.length > 0) {
  console.error('\x1b[31mThe generated dataset does not satisfy the suite:\x1b[0m');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// --- write -------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(here, 'testdata');
mkdirSync(outputDir, { recursive: true });

writeFileSync(resolve(outputDir, 'tiny.json'), `${JSON.stringify(dataset, null, 2)}\n`);
writeFileSync(
  resolve(outputDir, 'chrome-report.json'),
  `${JSON.stringify(toChromeReport(db, TEST_RUN_FIXED), null, 2)}\n`,
);

const summary = RUNS.map((plan) => {
  const run = db.runsById.get(plan.id)!;
  return `  ${run.id.padEnd(6)} ${run.appVersionId.padEnd(7)} ${run.model.padEnd(8)} ${(
    run.metrics.successRate * 100
  ).toFixed(1)}%`;
}).join('\n');

console.log(
  `Wrote ${outputDir}/tiny.json and chrome-report.json\n` +
    `  ${cases.length} cases x ${REPEATS} repeats across ${RUNS.length} runs\n${summary}`,
);
