/**
 * The review console's WebMCP surface, in three versions.
 *
 * The regression this demo is built around lives here, and it is deliberately
 * the kind nobody writes a ticket for: v2 does not break a tool, it *describes*
 * four of them worse. Two descriptions collapse into near-synonyms, one
 * argument loses its enum and its range, and one loses the sentence that said
 * which call has to come first.
 *
 * Nothing in v2 is wrong. It is all just less specific — which is precisely the
 * failure mode a test suite of the app's own code cannot see, and the reason
 * Catchfly diffs manifests at all.
 *
 * v3 restores the four, and adds a tool, so manifest deltas are non-empty in
 * both directions.
 */

import type { AppVersion, ToolSchema } from '@catchfly/core/types.ts';

import { CRITERIA, TRACKS } from './catalog.ts';

const tool = (name: string, description: string, properties: Record<string, unknown> = {}): ToolSchema => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false },
});

const SUBMISSION_ID = { type: 'string', description: 'A submission id such as DEV-1001.' };

/** The four tools v2 degrades, and the one v3 introduces. */
export const REGRESSED_TOOLS = [
  'search_submissions',
  'verify_technology_claim',
  'score_submission',
  'highlight_evidence',
] as const;

export const ADDED_IN_V3 = 'get_review_queue';

/**
 * Tools an agent might reach for that the console has never exposed. Plausible
 * enough to be invented under pressure, which is the point.
 */
export const PHANTOM_TOOLS = ['get_submission_score', 'reject_submission', 'list_judges'];

// --- the stable fourteen -----------------------------------------------

const STABLE: ToolSchema[] = [
  tool('list_submissions', 'List submissions filtered by track or eligibility, in submission order.', {
    track: { type: 'string', enum: [...TRACKS] },
    eligibleOnly: { type: 'boolean' },
  }),
  tool('inspect_readme', "Read the README file of a submission's repository.", { submissionId: SUBMISSION_ID }),
  tool('inspect_repository', "List the files and dependencies found in a submission's repository.", {
    submissionId: SUBMISSION_ID,
  }),
  tool(
    'detect_stack',
    "Report the technologies actually detected in a submission's repository, independent of what it declares.",
    { submissionId: SUBMISSION_ID },
  ),
  tool(
    'find_evidence',
    "Find passages in a submission's description or README that support a claim. Returns quoted spans with a spanId for each.",
    { submissionId: SUBMISSION_ID, claim: { type: 'string' } },
  ),
  tool('scan_prompt_injection', "Scan a submission's untrusted text for instructions aimed at the reviewing agent.", {
    submissionId: SUBMISSION_ID,
  }),
  tool('flag_submission', 'Flag a submission for organiser attention with a reason.', {
    submissionId: SUBMISSION_ID,
    reason: { type: 'string' },
  }),
  tool(
    'check_eligibility',
    'Check a submission against the four eligibility rules and return a per-rule verdict.',
    { submissionId: SUBMISSION_ID },
  ),
  tool('compare_submissions', 'Compare two submissions side by side across the rubric criteria.', {
    submissionId: SUBMISSION_ID,
    otherSubmissionId: SUBMISSION_ID,
  }),
  tool('get_rubric', 'Return the judging criteria and the score range each one uses.'),
  tool('build_shortlist', 'Add a submission to the shortlist for a track.', {
    submissionId: SUBMISSION_ID,
    track: { type: 'string', enum: [...TRACKS] },
  }),
  tool('open_submission', "Open a submission in the reviewer's console so the human sees it.", {
    submissionId: SUBMISSION_ID,
  }),
  tool('add_review_note', 'Attach a reviewer note to the submission currently open.', {
    submissionId: SUBMISSION_ID,
    note: { type: 'string' },
  }),
];

// --- the four that move ------------------------------------------------

const searchSubmissions = (description: string) =>
  tool('search_submissions', description, {
    query: { type: 'string' },
    track: { type: 'string', enum: [...TRACKS] },
    limit: { type: 'integer' },
  });

const getSubmission = (description: string) =>
  tool('get_submission', description, { submissionId: SUBMISSION_ID });

const verifyTechnologyClaim = (description: string) =>
  tool('verify_technology_claim', description, {
    submissionId: SUBMISSION_ID,
    technology: { type: 'string' },
  });

const scoreSubmission = (precise: boolean) =>
  tool(
    'score_submission',
    precise
      ? 'Record a score for one submission on one rubric criterion. Call get_rubric first if the criteria are not known.'
      : 'Record a score for a submission.',
    precise
      ? {
          submissionId: SUBMISSION_ID,
          criterion: { type: 'string', enum: [...CRITERIA], description: 'One of the four rubric criteria.' },
          score: { type: 'integer', minimum: 1, maximum: 10, description: 'An integer from 1 to 10.' },
        }
      : {
          submissionId: SUBMISSION_ID,
          criterion: { type: 'string' },
          score: { type: 'number' },
        },
  );

const highlightEvidence = (precise: boolean) =>
  tool(
    'highlight_evidence',
    precise
      ? 'Highlight an evidence span in the open submission. Call find_evidence first to obtain a spanId.'
      : 'Highlight text in a submission.',
    {
      submissionId: SUBMISSION_ID,
      spanId: precise
        ? { type: 'string', description: 'A spanId returned by find_evidence.' }
        : { type: 'string' },
    },
  );

const reviewQueue = tool('get_review_queue', 'List submissions still awaiting a human decision, newest first.', {
  track: { type: 'string', enum: [...TRACKS] },
});

// --- manifests ---------------------------------------------------------

const PRECISE_SEARCH = 'Search submissions by free text across title, team and description. Returns a ranked list.';
const PRECISE_GET = 'Fetch one submission by its exact id, including description, declared stack and links.';
const PRECISE_VERIFY =
  'Check one declared technology against what the repository contains. Use after detect_stack when a specific claim needs a verdict.';

const V1_TOOLS: ToolSchema[] = [
  searchSubmissions(PRECISE_SEARCH),
  getSubmission(PRECISE_GET),
  verifyTechnologyClaim(PRECISE_VERIFY),
  scoreSubmission(true),
  highlightEvidence(true),
  ...STABLE,
];

const V2_TOOLS: ToolSchema[] = [
  // Two descriptions that used to say different things now say the same thing.
  searchSubmissions('Find a submission.'),
  getSubmission('Find a submission by id.'),
  verifyTechnologyClaim('Check the technology of a submission.'),
  scoreSubmission(false),
  highlightEvidence(false),
  ...STABLE,
];

const V3_TOOLS: ToolSchema[] = [
  searchSubmissions(PRECISE_SEARCH),
  getSubmission(PRECISE_GET),
  verifyTechnologyClaim(PRECISE_VERIFY),
  scoreSubmission(true),
  highlightEvidence(true),
  ...STABLE,
  reviewQueue,
];

const byName = (tools: ToolSchema[]) => [...tools].sort((a, b) => a.name.localeCompare(b.name));

export const APP_VERSIONS: AppVersion[] = [
  {
    id: 'console-v1',
    label: 'console v1',
    releasedAt: '2026-08-01T09:00:00.000Z',
    note: 'Baseline manifest — each tool says what only it does.',
    toolManifest: byName(V1_TOOLS),
  },
  {
    id: 'console-v2',
    label: 'console v2',
    releasedAt: '2026-08-12T09:00:00.000Z',
    note: 'Tool descriptions shortened during a docs cleanup.',
    toolManifest: byName(V2_TOOLS),
  },
  {
    id: 'console-v3',
    label: 'console v3',
    releasedAt: '2026-08-21T09:00:00.000Z',
    note: 'Descriptions and argument constraints restored, plus a review queue tool.',
    toolManifest: byName(V3_TOOLS),
  },
];

export const manifestFor = (appVersionId: string): ToolSchema[] =>
  APP_VERSIONS.find((version) => version.id === appVersionId)?.toolManifest ?? [];

export const toolNamesFor = (appVersionId: string): string[] =>
  manifestFor(appVersionId).map((entry) => entry.name);

/** True when this version ships the vaguer descriptions. */
export const isRegressedVersion = (appVersionId: string): boolean => appVersionId === 'console-v2';
