/**
 * Turns the Devpost world into production-style sessions.
 *
 * The method matters more than the volume. Every session starts from a *plan*:
 * the call sequence a competent agent would make, computed from the hidden
 * ground truth. A session either replays its plan, or has exactly one thing
 * done to it — a tool swapped, an argument corrupted, two calls transposed, a
 * tool invented, an answer left unusable, a task abandoned half-way.
 *
 * Nothing here assigns a failure label. The mutated call sequence is handed to
 * the real `categorize()` with the plan as the expectation, exactly as an
 * imported Chrome report is, and whatever it answers is what the session
 * carries. That is the difference between data that can be interrogated and
 * data that merely agrees with the story it was written to tell.
 *
 * Seeded throughout: same seed, byte-identical output.
 */

import { categorize } from '@catchfly/core/categorize.ts';
import type { Deployment, Session, SessionOutcome, SessionToolCall } from '@catchfly/core/session-types.ts';
import type { ExpectedFunctionCall, Outcome, ToolCall, TrajectoryStep } from '@catchfly/core/types.ts';

import {
  catalog,
  CRITERIA,
  type Criterion,
  type Submission,
  TRACKS,
  type Track,
} from '@catchfly/devpost-world/catalog.ts';
// The plans are computed from the answers, which is exactly why this import is
// here and not in the package's barrel: a session's *ideal* call sequence needs
// the ground truth, and the console serving those calls must never see it.
import { groundTruthById } from '@catchfly/devpost-world/judging.ts';
import {
  execute,
  newSessionState,
  type SessionState,
} from '@catchfly/devpost-world/results.ts';
import { PHANTOM_TOOLS, toolNamesFor } from '@catchfly/devpost-world/tools.ts';

// --- deterministic jitter ----------------------------------------------

/** Mulberry32 — the same PRNG the test fixture uses, for the same reason. */
export function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

/**
 * A per-tool baseline latency derived from the name, so the same tool is
 * consistently fast or slow across every deployment.
 */
function baseDuration(toolName: string): number {
  let hash = 0;
  for (let index = 0; index < toolName.length; index += 1) {
    hash = (hash * 31 + toolName.charCodeAt(index)) >>> 0;
  }
  return 60 + (hash % 260);
}

function durationFor(toolName: string, random: () => number): number {
  const jittered = baseDuration(toolName) * (0.7 + random() * 0.8);
  // One call in fifteen hits a long tail, which is what makes p95 differ from p50.
  const tail = random() < 0.065 ? 2.5 + random() * 3 : 1;
  return Math.round(jittered * tail);
}

// --- plans -------------------------------------------------------------

const call = (functionName: string, args: Record<string, unknown> = {}): ToolCall => ({ functionName, args });

/**
 * The spanId `find_evidence` would actually hand back for this claim.
 *
 * A competent agent highlights the span it was given, not one it guessed, so
 * the ideal plan has to ask the backend the same question the agent would.
 * Deterministic: same submission and claim, same span.
 */
function spanFor(submissionId: string, claim: string): string {
  const probe = newSessionState();
  const found = execute('find_evidence', { submissionId, claim }, probe);
  const spans = found.ok ? (found.value as { spans: Array<{ spanId: string }> }).spans : [];
  return spans[0]?.spanId ?? `${submissionId}-span-1`;
}

type PlanContext = {
  submission: Submission;
  other: Submission;
  criterion: Criterion;
  track: Track;
};

export type FailureMode =
  | 'wrong-tool'
  | 'bad-argument'
  | 'sequencing'
  | 'phantom'
  | 'unusable'
  | 'abandoned';

export type WeightedFailureMode = { value: FailureMode; weight: number };

type Template = {
  id: string;
  intent: (context: PlanContext) => string;
  plan: (context: PlanContext) => ToolCall[];
  /**
   * Failure modes this template can plausibly exhibit. A comparison of two
   * submissions cannot fail on ordering, because its two lookups are genuinely
   * independent — encoding that here keeps the data from claiming otherwise.
   */
  modes: FailureMode[];
  /**
   * Relative share of traffic. A review console is used for reviewing: scoring
   * a submission is what people mostly do, and listing a track is what they
   * occasionally do. Uniform templates would make the tool mix a lie.
   */
  weight: number;
};

const TEMPLATES: Template[] = [
  {
    id: 'score-one-criterion',
    intent: ({ submission, criterion }) => `Score ${submission.id} on ${criterion}.`,
    plan: ({ submission, criterion }) => [
      call('get_rubric'),
      call('get_submission', { submissionId: submission.id }),
      call('score_submission', {
        submissionId: submission.id,
        criterion,
        score: groundTruthById.get(submission.id)!.scores[criterion],
      }),
    ],
    modes: ['bad-argument', 'unusable', 'abandoned'],
    weight: 4,
  },
  {
    id: 'score-every-criterion',
    intent: ({ submission }) => `Score ${submission.id} on every rubric criterion.`,
    plan: ({ submission }) => [
      call('get_rubric'),
      call('get_submission', { submissionId: submission.id }),
      ...CRITERIA.map((criterion) =>
        call('score_submission', {
          submissionId: submission.id,
          criterion,
          score: groundTruthById.get(submission.id)!.scores[criterion],
        }),
      ),
    ],
    modes: ['bad-argument', 'abandoned', 'unusable'],
    weight: 3,
  },
  {
    id: 'verify-webmcp-claim',
    intent: ({ submission }) => `Does ${submission.id} actually use WebMCP, or does it just say so?`,
    plan: ({ submission }) => [
      call('get_submission', { submissionId: submission.id }),
      call('inspect_repository', { submissionId: submission.id }),
      call('detect_stack', { submissionId: submission.id }),
      call('verify_technology_claim', { submissionId: submission.id, technology: 'WebMCP' }),
    ],
    modes: ['wrong-tool', 'phantom', 'unusable'],
    weight: 2,
  },
  {
    id: 'verify-declared-stack',
    intent: ({ submission }) => `${submission.id} declares ${submission.declaredStack.join(', ')} — check it.`,
    plan: ({ submission }) => [
      call('get_submission', { submissionId: submission.id }),
      call('inspect_repository', { submissionId: submission.id }),
      call('detect_stack', { submissionId: submission.id }),
      ...submission.declaredStack.map((technology) =>
        call('verify_technology_claim', { submissionId: submission.id, technology }),
      ),
    ],
    modes: ['wrong-tool', 'abandoned', 'unusable'],
    weight: 2,
  },
  {
    id: 'highlight-evidence',
    intent: ({ submission }) => `Show me the evidence that ${submission.id} exposes WebMCP tools.`,
    plan: ({ submission }) => [
      call('open_submission', { submissionId: submission.id }),
      call('find_evidence', { submissionId: submission.id, claim: 'exposes WebMCP tools' }),
      call('highlight_evidence', {
        submissionId: submission.id,
        spanId: spanFor(submission.id, 'exposes WebMCP tools'),
      }),
    ],
    modes: ['sequencing', 'unusable', 'abandoned'],
    weight: 2,
  },
  {
    id: 'evidence-for-criterion',
    intent: ({ submission, criterion }) => `Find and highlight what supports ${criterion} for ${submission.id}.`,
    plan: ({ submission, criterion }) => [
      call('open_submission', { submissionId: submission.id }),
      call('find_evidence', { submissionId: submission.id, claim: criterion }),
      call('highlight_evidence', { submissionId: submission.id, spanId: spanFor(submission.id, criterion) }),
      call('add_review_note', { submissionId: submission.id, note: `Evidence located for ${criterion}.` }),
    ],
    modes: ['sequencing', 'unusable', 'phantom'],
    weight: 2,
  },
  {
    id: 'search-track',
    intent: ({ track }) => `Which ${track} submissions are worth a closer look?`,
    plan: ({ track }) => [
      call('search_submissions', { query: 'agent tools', track, limit: 5 }),
      call('compare_submissions', {
        submissionId: catalog.find((entry) => entry.track === track)!.id,
        otherSubmissionId: [...catalog].reverse().find((entry) => entry.track === track)!.id,
      }),
    ],
    modes: ['wrong-tool', 'unusable', 'abandoned'],
    weight: 2,
  },
  {
    id: 'search-and-shortlist',
    intent: ({ track }) => `Shortlist the strongest ${track} submission.`,
    plan: ({ track, submission }) => [
      call('search_submissions', { query: track, track, limit: 5 }),
      call('get_submission', { submissionId: submission.id }),
      call('build_shortlist', { submissionId: submission.id, track }),
    ],
    modes: ['wrong-tool', 'unusable', 'abandoned'],
    weight: 2,
  },
  {
    id: 'find-duplicates',
    intent: ({ submission }) => `Is ${submission.id} a near-duplicate of anything else?`,
    plan: ({ submission, other }) => [
      call('search_submissions', { query: submission.title, limit: 5 }),
      call('compare_submissions', { submissionId: submission.id, otherSubmissionId: other.id }),
    ],
    modes: ['wrong-tool', 'unusable'],
    weight: 1,
  },
  {
    id: 'scan-injection',
    intent: ({ submission }) => `Check ${submission.id}'s description for instructions aimed at the reviewer.`,
    plan: ({ submission }) => {
      const truth = groundTruthById.get(submission.id)!;
      const calls = [
        call('get_submission', { submissionId: submission.id }),
        call('scan_prompt_injection', { submissionId: submission.id }),
      ];
      if (truth.hasInjection) {
        calls.push(call('flag_submission', { submissionId: submission.id, reason: 'Prompt injection in description' }));
      }
      return calls;
    },
    modes: ['unusable', 'abandoned', 'phantom'],
    weight: 2,
  },
  {
    id: 'check-eligibility',
    intent: ({ submission }) => `Is ${submission.id} eligible?`,
    plan: ({ submission }) => [
      call('get_submission', { submissionId: submission.id }),
      call('check_eligibility', { submissionId: submission.id }),
    ],
    modes: ['unusable', 'phantom'],
    weight: 2,
  },
  {
    id: 'triage-track',
    intent: ({ track }) => `List everything filed under ${track}.`,
    plan: ({ track }) => [call('list_submissions', { track })],
    modes: ['unusable', 'wrong-tool'],
    weight: 1,
  },
  {
    id: 'read-readme',
    intent: ({ submission }) => `Summarise ${submission.id}'s README.`,
    plan: ({ submission }) => [
      call('get_submission', { submissionId: submission.id }),
      call('inspect_readme', { submissionId: submission.id }),
    ],
    modes: ['unusable', 'abandoned'],
    weight: 1,
  },
  {
    id: 'note-for-human',
    intent: ({ submission }) => `Leave a note that ${submission.id} needs a human decision.`,
    plan: ({ submission }) => [
      call('open_submission', { submissionId: submission.id }),
      call('add_review_note', { submissionId: submission.id, note: 'Needs a human decision.' }),
    ],
    modes: ['unusable', 'abandoned'],
    weight: 1,
  },
  {
    id: 'full-review',
    intent: ({ submission }) => `Do a full first-pass review of ${submission.id}.`,
    plan: ({ submission, criterion }) => [
      call('get_submission', { submissionId: submission.id }),
      call('check_eligibility', { submissionId: submission.id }),
      call('inspect_repository', { submissionId: submission.id }),
      call('detect_stack', { submissionId: submission.id }),
      call('scan_prompt_injection', { submissionId: submission.id }),
      call('get_rubric'),
      call('score_submission', {
        submissionId: submission.id,
        criterion,
        score: groundTruthById.get(submission.id)!.scores[criterion],
      }),
      call('add_review_note', { submissionId: submission.id, note: 'First pass complete.' }),
    ],
    modes: ['bad-argument', 'abandoned', 'phantom', 'unusable'],
    weight: 3,
  },
];

// --- simulated execution -----------------------------------------------
//
// Nothing here decides whether a call succeeds. A mutation changes what the
// agent *did* — which tool, which arguments, in which order — and the console's
// own backend decides what happens next, exactly as it would for a real agent
// in a browser. That is what keeps these sessions an honest description of the
// app the eval runner will later be pointed at.

/** Applies exactly one mutation to a plan. Says nothing about the outcome of any call. */
function mutate(
  plan: ToolCall[],
  mode: FailureMode,
  random: () => number,
): { calls: ToolCall[]; outcome: SessionOutcome } {
  const copy = () => plan.map((entry) => ({ ...entry, args: { ...entry.args } }));

  switch (mode) {
    case 'wrong-tool': {
      // Reaching for the neighbouring tool. The call itself will succeed — the
      // console has no way to know it was not the one wanted — and the task
      // still fails, which is precisely why a blurred description is expensive.
      const swaps: Record<string, string> = {
        search_submissions: 'get_submission',
        verify_technology_claim: 'detect_stack',
        list_submissions: 'search_submissions',
      };
      const index = plan.findIndex((entry) => entry.functionName in swaps);
      if (index < 0) return { calls: copy(), outcome: 'failed' };
      const replacement = swaps[plan[index].functionName];
      const calls = copy();
      calls[index] = {
        functionName: replacement,
        args: replacement === 'get_submission' ? { submissionId: catalog[0].id } : { ...plan[index].args },
      };
      return { calls, outcome: 'failed' };
    }

    case 'bad-argument': {
      if (!plan.some((entry) => entry.functionName === 'score_submission')) {
        return { calls: copy(), outcome: 'failed' };
      }
      // Two ways to get it wrong once the enum and the range stopped being
      // documented. The misunderstanding is consistent within a session: an
      // agent that thinks the scale runs to 100 believes that for every
      // criterion, so a four-criterion task produces four rejected calls.
      const outOfRange = random() < 0.6;
      const calls = copy().map((entry) =>
        entry.functionName === 'score_submission'
          ? {
              functionName: 'score_submission',
              args: outOfRange
                ? { ...entry.args, score: (entry.args.score as number) * 10 }
                : { ...entry.args, criterion: String(entry.args.criterion).split('-')[0] },
            }
          : entry,
      );
      return { calls, outcome: 'failed' };
    }

    case 'sequencing': {
      const evidence = plan.findIndex((entry) => entry.functionName === 'find_evidence');
      const highlight = plan.findIndex((entry) => entry.functionName === 'highlight_evidence');
      if (evidence < 0 || highlight < 0) return { calls: copy(), outcome: 'failed' };
      const calls = copy();
      // Transpose them. Highlighting a span nobody has looked up yet is refused
      // by the backend — we do not write that refusal here, we cause it.
      [calls[evidence], calls[highlight]] = [calls[highlight], calls[evidence]];
      return { calls, outcome: 'failed' };
    }

    case 'phantom': {
      const calls = copy();
      const phantom = pick(random, PHANTOM_TOOLS);
      const at = Math.min(calls.length, 1 + Math.floor(random() * calls.length));
      calls.splice(at, 0, {
        functionName: phantom,
        args: { submissionId: plan[0]?.args.submissionId ?? catalog[0].id },
      });
      return { calls, outcome: 'failed' };
    }

    case 'unusable':
      // Every call correct, the answer still not usable.
      return { calls: copy(), outcome: 'failed' };

    case 'abandoned': {
      const keep = Math.max(1, Math.floor(random() * plan.length));
      return { calls: copy().slice(0, keep), outcome: 'abandoned' };
    }
  }
}

/** One executed call: what was asked, and what the console answered. */
type ExecutedCall = {
  call: ToolCall;
  status: 'success' | 'error';
  result: unknown;
  errorType?: string;
  errorMessage?: string;
};

/** Runs a call sequence against the console's backend, threading one page state. */
function run(calls: ToolCall[], state: SessionState): ExecutedCall[] {
  return calls.map((call) => {
    const outcome = execute(call.functionName, call.args, state);
    return outcome.ok
      ? { call, status: 'success' as const, result: outcome.value }
      : {
          call,
          status: 'error' as const,
          result: { error: outcome.message },
          errorType: outcome.errorType,
          errorMessage: outcome.message,
        };
  });
}

/** SessionOutcome is about the task; categorize() speaks in attempt outcomes. */
function outcomeForCategorizer(outcome: SessionOutcome): Outcome {
  if (outcome === 'completed') return 'pass';
  // An abandoned session never completed, which is what categorize calls 'error'.
  return outcome === 'abandoned' ? 'error' : 'fail';
}

const asExpected = (plan: ToolCall[]): ExpectedFunctionCall[] =>
  plan.map((entry) => ({ functionName: entry.functionName, arguments: entry.args }));

// --- narration ---------------------------------------------------------

function transcriptFor(
  intent: string | undefined,
  executed: ExecutedCall[],
  outcome: SessionOutcome,
): TrajectoryStep[] {
  const steps: TrajectoryStep[] = [
    { text: intent ? `Working on: ${intent}` : 'Working on the reviewer request.' },
  ];
  for (const entry of executed) {
    steps.push({
      reasoningText:
        entry.status === 'error'
          ? `Calling ${entry.call.functionName}; if this is rejected I will need another route.`
          : `Calling ${entry.call.functionName}.`,
      toolCalls: [{ functionName: entry.call.functionName, args: entry.call.args }],
      toolResults: [entry.result],
    });
  }
  steps.push({
    text:
      outcome === 'completed'
        ? 'Done.'
        : outcome === 'abandoned'
          ? 'Stopping here — I do not have what I need to finish this.'
          : 'I could not complete this reliably.',
  });
  return steps;
}

// --- assembly ----------------------------------------------------------

export type DeploymentPlan = {
  deployment: Deployment;
  sessionCount: number;
  /** Inclusive start / exclusive end of the traffic window, ISO 8601. */
  windowStart: string;
  windowEnd: string;
  /**
   * The manifest behaviour to simulate. A scale world may give each release a
   * distinct public id while reusing one of the three deliberately authored
   * schema profiles below it.
   */
  manifestProfileId?: 'console-v1' | 'console-v2' | 'console-v3';
  /** Exact manifest exposed by a synthetic scenario, when it is not a stock console profile. */
  knownTools?: string[];
  /** Only plans touching one of these tools receive the scenario-specific failure risk. */
  regressionTools?: string[];
  /** Scenario-specific failure shape. */
  regressionModes?: WeightedFailureMode[];
  /** Override only in a named scenario. */
  regressionFailureRate?: number;
  /** A non-functional incident/decoy can slow calls without changing outcomes. */
  latencyMultiplier?: number;
};

/**
 * Every deployment fails some of the time for reasons that have nothing to do
 * with the manifest: an agent gives up, or does everything right and still
 * answers badly. This is that floor, and it is the same on all three.
 */
const BASELINE_FAILURE_RATE = 0.08;

/**
 * The additional rate a vague manifest adds, for plans that actually touch a
 * tool it made vague. Separating the two draws is what keeps the baseline
 * failure modes present on every deployment — otherwise a filter chip that
 * works on v2 leads to an empty table on v1.
 */
const REGRESSION_FAILURE_RATE = 0.24;

/**
 * Failure modes that need no help from a bad description.
 *
 * `phantom` and `bad-argument` are in here at the far end of the tail. The eval
 * matrix measured neither on any manifest, but it measured twenty-five narrow
 * prompts; production is wider, agents do occasionally invent a tool or fill a
 * field badly whatever the docs say, and a project where those two categories
 * match nothing at all would ship a filter that leads to an empty table.
 */
const BASELINE_MODES: WeightedFailureMode[] = [
  { value: 'unusable', weight: 5 },
  { value: 'abandoned', weight: 4 },
  { value: 'wrong-tool', weight: 3 },
  { value: 'phantom', weight: 1 },
  { value: 'bad-argument', weight: 2 },
];

/** True when this plan uses a tool whose description v2 blurred. */
function touchesRegressedTool(planCalls: ToolCall[]): boolean {
  return planCalls.some((entry) =>
    ['search_submissions', 'verify_technology_claim', 'score_submission', 'highlight_evidence'].includes(
      entry.functionName,
    ),
  );
}

/** Picks from a weighted list. */
function weighted<T>(random: () => number, entries: Array<{ value: T; weight: number }>): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let target = random() * total;
  for (const entry of entries) {
    target -= entry.weight;
    if (target <= 0) return entry.value;
  }
  return entries[entries.length - 1].value;
}

/** Restricts a set of modes to those this particular plan can actually express. */
function expressible(modes: FailureMode[], names: Set<string>): FailureMode[] {
  return modes.filter((mode) => {
    if (mode === 'bad-argument') return names.has('score_submission');
    if (mode === 'sequencing') return names.has('find_evidence') && names.has('highlight_evidence');
    if (mode === 'wrong-tool') {
      return names.has('search_submissions') || names.has('verify_technology_claim') || names.has('list_submissions');
    }
    return true;
  });
}

/**
 * How a plan goes wrong when the manifest is the reason — weighted to match
 * what the eval matrix actually measured.
 *
 * The weights here were guesses once, and the guesses were wrong in a way worth
 * recording. The first version made a corrupted `score_submission` argument the
 * dominant failure, on the theory that an argument which lost its documented
 * range would start arriving out of range. Then the real runner produced 462
 * `score_submission` calls across three models and three manifests, and **not
 * one** was rejected: models read `type: number`, infer a sensible 1-to-10 from
 * the rubric, and are entirely unbothered by the missing constraint. The same
 * went for ordering — no model highlighted a span before looking one up.
 *
 * What the matrix did measure is confusion between tools that now describe
 * themselves alike: verify-versus-detect, search-versus-get. So that is what
 * dominates here.
 *
 * The modes measured at zero are kept at a low weight rather than deleted. Real
 * production is wider than a twenty-five-case suite of narrow prompts, and a
 * dataset with no argument errors at all would leave a filter chip in the UI
 * that never matches anything. They are a long tail, not the story.
 */
function schemaCausedModes(names: Set<string>): WeightedFailureMode[] {
  const modes: WeightedFailureMode[] = [];
  if (names.has('search_submissions') || names.has('verify_technology_claim')) {
    modes.push({ value: 'wrong-tool', weight: 8 });
  }
  if (names.has('verify_technology_claim')) modes.push({ value: 'phantom', weight: 2 });
  if (names.has('highlight_evidence')) modes.push({ value: 'sequencing', weight: 3 });
  if (names.has('score_submission')) {
    // A vaguer description does not stop an agent scoring; it stops it being
    // sure the score was the one asked for.
    modes.push({ value: 'unusable', weight: 3 });
    modes.push({ value: 'bad-argument', weight: 2 });
  }
  // An agent that cannot tell which of two tools it wants sometimes stops
  // rather than guessing, which is the most defensible thing it can do.
  if (modes.length > 0) modes.push({ value: 'abandoned', weight: 2 });
  return modes;
}

function baselineModeFor(template: Template, names: Set<string>, random: () => number): FailureMode {
  const allowed = new Set(template.modes);
  const available = BASELINE_MODES.filter(
    (entry) =>
      // `phantom` and `bad-argument` are the tail: they are allowed on any
      // template, because inventing a tool is not something a template invites.
      (allowed.has(entry.value) || entry.value === 'phantom' || entry.value === 'bad-argument') &&
      expressible([entry.value], names).length > 0,
  );
  return available.length > 0 ? weighted(random, available) : 'unusable';
}

/** Weighted template choice, so the tool mix reflects what the console is for. */
function pickTemplate(random: () => number): Template {
  const total = TEMPLATES.reduce((sum, template) => sum + template.weight, 0);
  let target = random() * total;
  for (const template of TEMPLATES) {
    target -= template.weight;
    if (target <= 0) return template;
  }
  return TEMPLATES[TEMPLATES.length - 1];
}

export function generateSessions(plans: DeploymentPlan[], seed: number): Session[] {
  const random = rng(seed);
  const sessions: Session[] = [];
  let counter = 0;

  for (const plan of plans) {
    const manifestProfileId = plan.manifestProfileId ?? plan.deployment.appVersionId;
    const knownTools = plan.knownTools ?? toolNamesFor(manifestProfileId);
    const start = Date.parse(plan.windowStart);
    const span = Date.parse(plan.windowEnd) - start;

    const offsets: number[] = [];
    for (let index = 0; index < plan.sessionCount; index += 1) offsets.push(random() * span);
    offsets.sort((a, b) => a - b);

    for (const offset of offsets) {
      counter += 1;
      const template = pickTemplate(random);
      const submission = pick(random, catalog);
      const other = pick(random, catalog);
      const context: PlanContext = {
        submission,
        other: other.id === submission.id ? catalog[(catalog.indexOf(submission) + 1) % catalog.length] : other,
        criterion: pick(random, CRITERIA),
        track: pick(random, TRACKS),
      };

      const planCalls = template.plan(context);
      const names = new Set(planCalls.map((entry) => entry.functionName));

      // Two independent draws, always taken so the stream does not depend on
      // which branch wins. The schema-caused failure takes precedence when both
      // land: it is the more specific explanation.
      const baselineDraw = random();
      const regressionDraw = random();
      const touchesScenario = plan.regressionTools
        ? planCalls.some((entry) => plan.regressionTools!.includes(entry.functionName))
        : manifestProfileId === 'console-v2' && touchesRegressedTool(planCalls);
      const schemaModes =
        touchesScenario
          ? (plan.regressionModes ?? schemaCausedModes(names)).filter(
              (entry) => expressible([entry.value], names).length > 0,
            )
          : [];

      let mode: FailureMode | null = null;
      if (schemaModes.length > 0 && regressionDraw < (plan.regressionFailureRate ?? REGRESSION_FAILURE_RATE)) {
        mode = weighted(random, schemaModes);
      } else if (baselineDraw < BASELINE_FAILURE_RATE) {
        mode = baselineModeFor(template, names, random);
      }

      const { calls, outcome }: { calls: ToolCall[]; outcome: SessionOutcome } = mode
        ? mutate(planCalls, mode, random)
        : { calls: planCalls, outcome: 'completed' };

      // One page state per session, exactly like one browser tab. This is where
      // the sequencing failure becomes real: a highlight before its lookup finds
      // an empty set of spans and is refused by the backend itself.
      const state = newSessionState();
      const executed = run(calls, state);

      const startedAt = new Date(Math.round(start + offset)).toISOString();
      let cursor = Date.parse(startedAt);
      const toolCalls: SessionToolCall[] = executed.map((entry) => {
        const durationMs = Math.round(
          durationFor(entry.call.functionName, random) * (plan.latencyMultiplier ?? 1),
        );
        const timestamp = new Date(cursor).toISOString();
        cursor += durationMs + Math.round(200 + random() * 1400);
        return {
          timestamp,
          toolName: entry.call.functionName,
          toolSchemaVersion: plan.deployment.appVersionId,
          arguments: entry.call.args,
          result: entry.result,
          status: entry.status,
          durationMs,
          ...(entry.errorType ? { errorType: entry.errorType } : {}),
          ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        };
      });

      // Most apps capture the request; some do not, and the model must survive that.
      const intent = random() < 0.85 ? template.intent(context) : undefined;
      const identified = random() < 0.7;

      const category = categorize({
        expectedCall: asExpected(planCalls),
        actualCalls: calls.map((entry) => ({ functionName: entry.functionName, args: entry.args })),
        outcome: outcomeForCategorizer(outcome),
        knownTools,
      });

      // Attribute the failure to the call that was rejected, or to the tool the
      // expectation named and the agent skipped.
      const erroredCall = toolCalls.find((entry) => entry.status === 'error');
      const missing = planCalls.find(
        (entry) => !calls.some((actual) => actual.functionName === entry.functionName),
      );
      const failureTool = erroredCall?.toolName ?? missing?.functionName;

      sessions.push({
        id: `s-${String(counter).padStart(4, '0')}`,
        deploymentId: plan.deployment.id,
        environment: plan.deployment.environment,
        startedAt,
        endedAt: new Date(cursor).toISOString(),
        ...(identified ? { agent: 'chrome-agent', model: pick(random, ['gemini-3.5-flash', 'claude-sonnet-5', 'gpt-5.6-luna']) } : {}),
        ...(intent === undefined ? {} : { intent }),
        outcome,
        ...(category === undefined ? {} : { failureCategory: category }),
        ...(outcome === 'completed' || failureTool === undefined ? {} : { failureTool }),
        toolCalls,
        // Narration is expensive to store, so only failures carry it — those are
        // the sessions anyone opens.
        ...(outcome !== 'completed' && random() < 0.45
          ? { transcript: transcriptFor(intent, executed, outcome) }
          : {}),
        metadata: { template: template.id },
      });
    }
  }

  return sessions;
}

export const TEMPLATE_IDS = TEMPLATES.map((template) => template.id);
