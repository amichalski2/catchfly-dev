/**
 * Deterministic large-scale world for the Catchfly demo.
 *
 * This is the one canonical demo dataset. It is visibly synthetic and exists
 * to make cross-view investigation materially harder than reading a chart.
 * No generated payload is committed. With `--write` it goes straight to
 * Supabase through the existing relational stores.
 *
 *   npm run mock                       # generate and validate in memory
 *   npm run mock -- --scale=tiny       # a fast local shape check
 *   npm run mock -- --write            # seed the default demo project
 */

import { categorize, flattenExpected } from '@catchfly/core/categorize.ts';
import type { Deployment } from '@catchfly/core/session-types.ts';
import type {
  AppVersion,
  CatchflyDataset,
  EvalCase,
  EvalRun,
  ExpectedFunctionCall,
  ToolCall,
} from '@catchfly/core/types.ts';
import { clearProjectSessions, saveSessions } from '../netlify/functions/lib/session-store.ts';
import { saveDataset } from '../netlify/functions/lib/store.ts';
import { APP_VERSIONS, PHANTOM_TOOLS } from '@catchfly/devpost-world/tools.ts';
import { DEVPOST_CASES } from './devpost/eval-cases.ts';
import {
  generateSessions,
  rng,
  type DeploymentPlan,
  type WeightedFailureMode,
} from './devpost/sessions.ts';

const PROJECT_ID = 'devpost-review-scale';
const PROJECT_NAME = 'Devpost Review Console — Investigation Lab';
const GENERATOR_VERSION = 'scale-world-v2';
const SEED = 20260827;
const MODELS = ['claude-sonnet-5', 'gpt-5.6-luna', 'gemini-3.7-flash', 'qwen3-32b', 'llama-4-scout'];

type ProfileId = 'console-v1' | 'console-v2' | 'console-v3';
type EvalMutation = 'tool' | 'args' | 'sequence' | 'phantom' | 'unusable' | 'abandoned';
type Scenario = {
  id: string;
  label: string;
  profile: ProfileId;
  affectedTools: string[];
  failureRate: number;
  productionModes: WeightedFailureMode[];
  evalModes: EvalMutation[];
  latencyMultiplier?: number;
  omitTools?: string[];
};

/**
 * One cycle is a compact incident history, not one vague manifest copied under
 * new release numbers. Six releases fail differently; latency is a false lead.
 */
const SCENARIOS: Scenario[] = [
  {
    id: 'control', label: 'clean control', profile: 'console-v1', affectedTools: [], failureRate: 0,
    productionModes: [], evalModes: [],
  },
  {
    id: 'selection', label: 'search / verify overlap', profile: 'console-v1',
    affectedTools: ['search_submissions', 'get_submission', 'verify_technology_claim'], failureRate: 0.28,
    productionModes: [{ value: 'wrong-tool', weight: 1 }], evalModes: ['tool'],
  },
  {
    id: 'arguments', label: 'score contract loosened', profile: 'console-v1',
    affectedTools: ['score_submission'], failureRate: 0.30,
    productionModes: [{ value: 'bad-argument', weight: 1 }], evalModes: ['args'],
  },
  {
    id: 'sequencing', label: 'evidence precondition removed', profile: 'console-v1',
    affectedTools: ['highlight_evidence'], failureRate: 0.34,
    productionModes: [{ value: 'sequencing', weight: 1 }], evalModes: ['sequence'],
  },
  {
    id: 'removed-tool', label: 'verification tool missing', profile: 'console-v1',
    affectedTools: ['verify_technology_claim'], failureRate: 0.38,
    productionModes: [{ value: 'phantom', weight: 1 }], evalModes: ['phantom'],
    omitTools: ['verify_technology_claim'],
  },
  {
    id: 'answer-quality', label: 'unusable scoring answer', profile: 'console-v1',
    affectedTools: ['score_submission'], failureRate: 0.26,
    productionModes: [{ value: 'unusable', weight: 1 }], evalModes: ['unusable'],
  },
  {
    id: 'abandonment', label: 'ambiguous review path', profile: 'console-v1',
    affectedTools: ['search_submissions', 'verify_technology_claim'], failureRate: 0.24,
    productionModes: [{ value: 'abandoned', weight: 1 }], evalModes: ['abandoned'],
  },
  {
    id: 'latency-decoy', label: 'latency spike · no quality regression', profile: 'console-v1',
    affectedTools: [], failureRate: 0, productionModes: [], evalModes: [], latencyMultiplier: 3.4,
  },
  {
    id: 'recovery', label: 'contract recovery', profile: 'console-v3', affectedTools: [], failureRate: 0,
    productionModes: [], evalModes: [],
  },
];

type Scale = 'tiny' | 'demo';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const scale = (argument('scale') === 'tiny' ? 'tiny' : 'demo') as Scale;
const shouldWrite = process.argv.includes('--write');
const deploymentCount = scale === 'tiny' ? 6 : 18;
const sessionCount = scale === 'tiny' ? 600 : 25_000;
const repetitions = 3;

function isoAt(day: number): string {
  return new Date(Date.UTC(2026, 5, 1 + day, 9, 0, 0)).toISOString();
}

function profileVersion(scenario: Scenario, index: number): AppVersion {
  const source = APP_VERSIONS.find((entry) => entry.id === scenario.profile)!;
  const regressed = APP_VERSIONS.find((entry) => entry.id === 'console-v2')!;
  const regressedByName = new Map(regressed.toolManifest.map((tool) => [tool.name, tool]));
  const number = String(index + 1).padStart(2, '0');
  const toolManifest = source.toolManifest
    .filter((tool) => !scenario.omitTools?.includes(tool.name))
    .map((tool) => {
      if (!scenario.affectedTools.includes(tool.name)) return structuredClone(tool);
      const blurred = structuredClone(regressedByName.get(tool.name) ?? tool);
      // Keep the two score incidents causally distinct: one loosens only the
      // input contract, the other changes only the behavioural description.
      if (scenario.id === 'arguments') return { ...blurred, description: tool.description };
      if (scenario.id === 'answer-quality') {
        return { ...structuredClone(tool), description: 'Record a score for a submission.' };
      }
      return blurred;
    });
  return {
    ...source,
    id: `scale-v${number}`,
    label: `console ${number} · ${scenario.label}`,
    releasedAt: isoAt(index * 5),
    note: `Synthetic scenario: ${scenario.id}.`,
    toolManifest,
  };
}

/**
 * An explicit release schedule rather than `index % SCENARIOS.length`. Round
 * robin gave every pattern exactly two occurrences, which made "observed 2x"
 * a property of the generator instead of a finding — anyone reading the
 * dashboard could see that every count was the same and discount all of them.
 *
 * Two rules hold it together: a control opens each cycle, because that is what
 * the incident read model splits on and measures against; and every scenario
 * appears at least once, or it vanishes from the ranking entirely.
 */
const SCHEDULE: string[] = [
  'control', 'selection', 'arguments', 'sequencing', 'removed-tool',
  'selection', 'abandonment', 'latency-decoy', 'recovery',
  'control', 'selection', 'arguments', 'answer-quality', 'sequencing',
  'abandonment', 'answer-quality', 'latency-decoy', 'recovery',
];

const scenarioFor = (index: number): Scenario => {
  const id = SCHEDULE[index % SCHEDULE.length];
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) throw new Error(`Release schedule names an unknown scenario: ${id}`);
  return scenario;
};
const versions = Array.from({ length: deploymentCount }, (_, index) =>
  profileVersion(scenarioFor(index), index),
);
const deployments: Deployment[] = versions.map((version, index) => ({
  id: `scale-deploy-${String(index + 1).padStart(2, '0')}`,
  appVersionId: version.id,
  environment: 'production',
  deployedAt: version.releasedAt,
  commitSha: `s${String(index + 1).padStart(6, '0')}`,
  note: version.note,
}));

function sessionsFor(index: number): number {
  const base = Math.floor(sessionCount / deploymentCount);
  return index === deploymentCount - 1 ? sessionCount - base * (deploymentCount - 1) : base;
}

const plans: DeploymentPlan[] = deployments.map((deployment, index) => {
  const scenario = scenarioFor(index);
  const version = versions[index];
  return {
    deployment,
    sessionCount: sessionsFor(index),
    windowStart: isoAt(index * 5),
    windowEnd: isoAt(index * 5 + 5),
    manifestProfileId: scenario.profile,
    knownTools: version.toolManifest.map((tool) => tool.name),
    regressionTools: scenario.affectedTools,
    regressionModes: scenario.productionModes,
    regressionFailureRate: scenario.failureRate,
    latencyMultiplier: scenario.latencyMultiplier,
  };
});

/** Four cohorts turn the authored 25-case suite into 100 independently named cases. */
function scaleCases(): EvalCase[] {
  const cohorts = ['accessibility', 'agent-experience', 'developer-tools', 'trust-safety'];
  return cohorts.flatMap((cohort, cohortIndex) =>
    DEVPOST_CASES.map((entry) => ({
      ...entry,
      caseId: `${entry.caseId}-${cohortIndex + 1}`,
      name: `${entry.name} · ${cohort}`,
      prompt: `${entry.prompt}\nContext: review the ${cohort} cohort.`,
    })),
  );
}

function requiredCalls(evalCase: EvalCase): ToolCall[] {
  return flattenExpected(evalCase.expectedCall)
    .filter((entry) => !entry.optional)
    .map((entry: ExpectedFunctionCall) => ({
      functionName: entry.functionName,
      args: entry.arguments ? structuredClone(entry.arguments) : {},
    }));
}

function mutatedCalls(
  expected: ToolCall[],
  knownTools: string[],
  mode: EvalMutation,
): ToolCall[] {
  const actual = expected.map((call) => ({ ...call, args: structuredClone(call.args) }));
  if (mode === 'tool' && actual.length > 0) {
    const replacement = knownTools.find((name) => name !== actual[0].functionName) ?? actual[0].functionName;
    actual[0] = { ...actual[0], functionName: replacement };
  } else if (mode === 'args' && actual.length > 0) {
    actual[0] = { ...actual[0], args: {} };
  } else if (mode === 'sequence' && actual.length > 1) {
    [actual[0], actual[1]] = [actual[1], actual[0]];
  } else if (mode === 'phantom' && actual.length > 0) {
    actual[actual.length - 1] = { ...actual[actual.length - 1], functionName: PHANTOM_TOOLS[0] };
  } else if (mode === 'abandoned' && actual.length > 0) {
    actual.splice(Math.floor(actual.length / 2));
  }
  return actual;
}

function buildRun(versionIndex: number, model: string, cases: EvalCase[]): EvalRun {
  const version = versions[versionIndex];
  const scenario = scenarioFor(versionIndex);
  const knownTools = version.toolManifest.map((tool) => tool.name);
  const random = rng(SEED + versionIndex * 1_009 + MODELS.indexOf(model) * 97);
  const results = cases.flatMap((evalCase) =>
    Array.from({ length: repetitions }, (_, repeat) => {
      const expected = requiredCalls(evalCase);
      const baseFailure = 0.055 + (MODELS.indexOf(model) % 3) * 0.012;
      const affected = expected.some((call) => scenario.affectedTools.includes(call.functionName));
      const fails = random() < baseFailure + (affected ? scenario.failureRate : 0);
      const modes: EvalMutation[] = affected && scenario.evalModes.length > 0
        ? scenario.evalModes
        : ['args', 'sequence', 'phantom', 'unusable'];
      const mode = modes[Math.floor(random() * modes.length)];
      const actualCalls = fails ? mutatedCalls(expected, knownTools, mode) : expected;
      const outcome: 'pass' | 'fail' = fails ? 'fail' : 'pass';
      const category = categorize({ expectedCall: evalCase.expectedCall, actualCalls, outcome, knownTools });
      const latencyMs = Math.round(
        (350 + random() * 1_800 + actualCalls.length * 130) * (scenario.latencyMultiplier ?? 1),
      );
      return {
        caseId: evalCase.caseId,
        runIndex: repeat + 1,
        outcome,
        actualCalls,
        // Keep the vast list light. Session traces are the production drill-down;
        // failures retain enough context to compare behaviour when expanded.
        trajectory: fails ? [{ text: `Synthetic ${category ?? 'failure'} on ${evalCase.caseId}.`, toolCalls: actualCalls }] : [],
        latencyMs,
        ...(category ? { category } : {}),
      };
    }),
  );
  const passCount = results.filter((result) => result.outcome === 'pass').length;
  const failCount = results.length - passCount;
  return {
    id: `scale-${version.id}-${model}`,
    appVersionId: version.id,
    model,
    backend: 'synthetic-ground-truth',
    timestamp: version.releasedAt,
    dataOrigin: 'synthetic',
    metrics: {
      testCount: results.length,
      passCount,
      failCount,
      errorCount: 0,
      successRate: passCount / results.length,
      avgLatencyMs: Math.round(results.reduce((total, result) => total + (result.latencyMs ?? 0), 0) / results.length),
    },
    results,
  };
}

const cases = scaleCases();
const runs = versions.flatMap((_, index) => MODELS.map((model) => buildRun(index, model, cases)));
const sessions = generateSessions(plans, SEED).map((session) => ({ ...session, dataOrigin: 'synthetic' as const }));

const dataset: CatchflyDataset = {
  project: {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    appVersions: versions,
    dataOrigin: 'synthetic',
    generatorVersion: GENERATOR_VERSION,
    generatorSeed: String(SEED),
  },
  cases,
  runs,
};

function assertWorld(): void {
  const expectedResults = deploymentCount * MODELS.length * cases.length * repetitions;
  const actualResults = runs.reduce((total, run) => total + run.results.length, 0);
  const scenarioRuns = (scenarioId: string) =>
    runs.filter((run) => {
      const index = versions.findIndex((version) => version.id === run.appVersionId);
      return index >= 0 && scenarioFor(index).id === scenarioId;
    });
  const control = scenarioRuns('control');
  const incidents = runs.filter((run) => {
    const index = versions.findIndex((version) => version.id === run.appVersionId);
    return index >= 0 && scenarioFor(index).failureRate > 0;
  });
  const average = (list: EvalRun[]) => list.reduce((sum, run) => sum + run.metrics.successRate, 0) / list.length;
  const sessionsForScenario = (scenarioId: string) => {
    const deploymentIds = new Set(
      deployments
        .filter((_, index) => scenarioFor(index).id === scenarioId)
        .map((deployment) => deployment.id),
    );
    return sessions.filter((session) => deploymentIds.has(session.deploymentId));
  };
  const issues: string[] = [];
  if (sessions.length !== sessionCount) issues.push(`expected ${sessionCount} sessions, got ${sessions.length}`);
  if (actualResults !== expectedResults) issues.push(`expected ${expectedResults} eval attempts, got ${actualResults}`);
  if (control.length > 0 && incidents.length > 0 && average(incidents) >= average(control) - 0.02) {
    issues.push('incident releases do not create a visible eval regression');
  }
  const expectedSignals: Array<[string, (session: (typeof sessions)[number]) => boolean]> = [
    ['selection', (session) => session.failureCategory === 'tool-selection'],
    ['arguments', (session) => session.failureCategory === 'argument-errors'],
    ['sequencing', (session) => session.failureCategory === 'sequencing'],
    ['removed-tool', (session) => session.failureCategory === 'hallucinated-tool'],
    ['answer-quality', (session) => session.failureCategory === 'structured-output'],
    ['abandonment', (session) => session.outcome === 'abandoned'],
  ];
  for (const [scenarioId, matches] of expectedSignals) {
    const scenarioSessions = sessionsForScenario(scenarioId);
    if (scenarioSessions.length > 0 && !scenarioSessions.some(matches)) {
      issues.push(`${scenarioId} has no expected production signal`);
    }
  }
  const expectedEvalCategories = new Map([
    ['selection', 'tool-selection'],
    ['arguments', 'argument-errors'],
    ['sequencing', 'sequencing'],
    ['removed-tool', 'hallucinated-tool'],
    ['answer-quality', 'structured-output'],
    ['abandonment', 'tool-selection'],
  ]);
  for (const [scenarioId, category] of expectedEvalCategories) {
    const scenarioAttempts = scenarioRuns(scenarioId).flatMap((run) => run.results);
    if (scenarioAttempts.length > 0 && !scenarioAttempts.some((result) => result.category === category)) {
      issues.push(`${scenarioId} has no ${category} eval signal`);
    }
  }
  const controlSessions = sessionsForScenario('control');
  const latencySessions = sessionsForScenario('latency-decoy');
  const meanDuration = (items: typeof sessions) =>
    items.reduce(
      (sum, session) => sum + session.toolCalls.reduce((callSum, call) => callSum + call.durationMs, 0),
      0,
    ) / items.length;
  if (
    controlSessions.length > 0 &&
    latencySessions.length > 0 &&
    meanDuration(latencySessions) < meanDuration(controlSessions) * 2
  ) {
    issues.push('latency decoy is not visibly slower than control');
  }
  if (issues.length > 0) throw new Error(`Scale world validation failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
}

assertWorld();
const calls = sessions.reduce((total, session) => total + session.toolCalls.length, 0);
console.log(
  `${PROJECT_ID}: ${versions.length} versions, ${deployments.length} deployments, ${sessions.length} sessions, ` +
    `${calls} tool calls, ${cases.length} cases, ${runs.length} runs, ` +
    `${runs.reduce((total, run) => total + run.results.length, 0)} eval attempts`,
);

if (shouldWrite) {
  // Clear traffic before saveDataset prunes app versions; deployments carry a
  // foreign key to them. This also gives --scale=tiny true replace semantics
  // after a previous full demo seed.
  await clearProjectSessions(PROJECT_ID);
  await saveDataset(dataset, 'Synthetic, deterministic Devpost investigation world. Metrics are generated from the same plans and categoriser used for traces.');
  // Keep each write bounded to one deployment. The store already chunks rows,
  // so this stays below serverless body limits and can be resumed safely.
  for (const deployment of deployments) {
    await saveSessions(
      PROJECT_ID,
      [deployment],
      sessions.filter((session) => session.deploymentId === deployment.id),
      'synthetic',
    );
  }
  console.log(`Seeded ${PROJECT_ID} into Supabase.`);
}
