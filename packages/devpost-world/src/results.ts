/**
 * What the console actually does when a tool is called.
 *
 * One implementation, two callers: the real app in the browser, and the
 * generator that manufactures the demo's production sessions. They must not
 * drift, because the synthetic sessions must describe traffic from this exact implementation
 * against *this* app — if the two disagree, the seeded history stops being a
 * record of anything.
 *
 * The validation here is deliberately **version-independent**. v2 of the
 * manifest describes four tools more vaguely than v1 did; it does not accept
 * anything v1 rejected. That asymmetry is the whole mechanism of the demo: the
 * documentation got worse, the contract did not, and agents that relied on the
 * documentation started failing a contract that never moved.
 *
 * Imports catalog and app-data only. Never judging: this file runs in the
 * browser, and the answers must not be in the bundle.
 */

import { appFactsById, eligibilityVerdicts, injectionFindings, repoFiles } from './app-data.ts';
import { catalog, catalogById, CRITERIA, type Criterion, type Track, TRACKS } from './catalog.ts';

/**
 * What one page visit accumulates.
 *
 * Only two things need remembering across calls: the evidence spans that have
 * actually been looked up (so highlighting one that has not is refusable), and
 * the scores recorded so far (so a comparison can show this reviewer's own work
 * without ever reaching for the judges').
 */
export type SessionState = {
  foundSpanIds: Set<string>;
  scoresThisSession: Map<string, Partial<Record<Criterion, number>>>;
};

export const newSessionState = (): SessionState => ({
  foundSpanIds: new Set(),
  scoresThisSession: new Map(),
});

export type ToolErrorType = 'invalid_argument' | 'precondition_failed' | 'not_found' | 'unknown_tool';

export type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; errorType: ToolErrorType; message: string };

const ok = (value: unknown): ToolOutcome => ({ ok: true, value });
const bad = (errorType: ToolErrorType, message: string): ToolOutcome => ({ ok: false, errorType, message });

// --- evidence ----------------------------------------------------------

/** Sentences of everything an agent could quote, each with a stable id. */
function spansOf(submissionId: string): Array<{ spanId: string; quote: string; source: string }> {
  const submission = catalogById.get(submissionId);
  if (!submission) return [];
  const split = (text: string) =>
    text
      .split(/(?<=\.)\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);

  const spans = [
    ...split(submission.description).map((quote) => ({ quote, source: 'description' })),
    ...split(submission.readme.replace(/^#.*$/gm, '').replace(/\n+/g, ' ')).map((quote) => ({
      quote,
      source: 'README.md',
    })),
  ];
  // Index-based ids, so the same span is the same id on every call and across
  // the generator and the app.
  return spans.map((span, index) => ({ spanId: `${submissionId}-span-${index + 1}`, ...span }));
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

// --- search ------------------------------------------------------------

/** How well one submission answers a free-text query. */
function score(submissionId: string, query: string): number {
  const submission = catalogById.get(submissionId);
  if (!submission) return 0;
  const needles = words(query);
  if (needles.length === 0) return 1;
  const haystack = `${submission.title} ${submission.team} ${submission.description} ${submission.track}`.toLowerCase();
  let total = 0;
  for (const needle of needles) {
    if (submission.title.toLowerCase().includes(needle)) total += 3;
    else if (haystack.includes(needle)) total += 1;
  }
  return total;
}

// --- the backend -------------------------------------------------------

const asString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Runs one tool call. Returns a refusal rather than throwing, so the generator
 * can record it as a failed call and the app can turn it into a tool error —
 * one description of what happened, two presentations of it.
 */
export function execute(
  functionName: string,
  args: Record<string, unknown>,
  state: SessionState,
): ToolOutcome {
  const submissionId = asString(args.submissionId);
  const submission = submissionId ? catalogById.get(submissionId) : undefined;
  const facts = submissionId ? appFactsById.get(submissionId) : undefined;

  /** Every submission-scoped tool needs the submission to exist. */
  const needsSubmission = (): ToolOutcome | null => {
    if (!submissionId) return bad('invalid_argument', '"submissionId" is required');
    if (!submission || !facts) return bad('not_found', `No submission "${submissionId}"`);
    return null;
  };

  switch (functionName) {
    case 'get_rubric':
      return ok({ criteria: CRITERIA, scoreRange: [1, 10] });

    case 'search_submissions': {
      const query = asString(args.query) ?? '';
      const track = asString(args.track);
      if (track && !TRACKS.includes(track as Track)) {
        return bad('invalid_argument', `"track" must be one of: ${TRACKS.join(', ')}`);
      }
      const rawLimit = args.limit;
      const limit =
        rawLimit === undefined ? 5 : Number.isInteger(rawLimit) ? Math.max(1, Math.min(30, Number(rawLimit))) : null;
      if (limit === null) return bad('invalid_argument', '"limit" must be an integer');

      const matches = catalog
        .filter((entry) => !track || entry.track === track)
        .map((entry) => ({ entry, weight: score(entry.id, query) }))
        .filter((row) => row.weight > 0)
        .sort((a, b) => b.weight - a.weight || a.entry.id.localeCompare(b.entry.id))
        .slice(0, limit)
        .map((row) => ({ id: row.entry.id, title: row.entry.title, track: row.entry.track }));
      return ok({ matches, total: matches.length });
    }

    case 'list_submissions': {
      const track = asString(args.track);
      if (track && !TRACKS.includes(track as Track)) {
        return bad('invalid_argument', `"track" must be one of: ${TRACKS.join(', ')}`);
      }
      const eligibleOnly = args.eligibleOnly === true;
      const rows = catalog
        .filter((entry) => !track || entry.track === track)
        .filter((entry) => !eligibleOnly || appFactsById.get(entry.id)?.eligible === true)
        .map((entry) => ({ id: entry.id, title: entry.title, track: entry.track, team: entry.team }));
      return ok({ submissions: rows, total: rows.length });
    }

    case 'get_submission': {
      const missing = needsSubmission();
      if (missing) return missing;
      return ok({
        id: submission!.id,
        title: submission!.title,
        team: submission!.team,
        track: submission!.track,
        description: submission!.description,
        declaredStack: submission!.declaredStack,
        repoUrl: submission!.repoUrl,
        demoUrl: submission!.demoUrl,
        submittedAt: submission!.submittedAt,
      });
    }

    case 'inspect_readme': {
      const missing = needsSubmission();
      if (missing) return missing;
      return ok({ readme: submission!.readme });
    }

    case 'inspect_repository': {
      const missing = needsSubmission();
      if (missing) return missing;
      return ok({ files: repoFiles(submissionId!), dependencies: facts!.actualStack });
    }

    case 'detect_stack': {
      const missing = needsSubmission();
      if (missing) return missing;
      return ok({ detected: facts!.actualStack });
    }

    case 'verify_technology_claim': {
      const missing = needsSubmission();
      if (missing) return missing;
      const technology = asString(args.technology);
      if (!technology) return bad('invalid_argument', '"technology" is required');
      const confirmed = facts!.actualStack.some(
        (entry) => entry.toLowerCase() === technology.toLowerCase(),
      );
      return ok({
        technology,
        declared: submission!.declaredStack.some((entry) => entry.toLowerCase() === technology.toLowerCase()),
        confirmed,
      });
    }

    case 'find_evidence': {
      const missing = needsSubmission();
      if (missing) return missing;
      const claim = asString(args.claim);
      if (!claim) return bad('invalid_argument', '"claim" is required');

      const needles = words(claim);
      const ranked = spansOf(submissionId!)
        .map((span) => ({
          span,
          weight: needles.filter((needle) => span.quote.toLowerCase().includes(needle)).length,
        }))
        .sort((a, b) => b.weight - a.weight);
      // Always return the nearest thing rather than nothing: an agent that gets
      // an empty list has no move left, and a reviewer looking for evidence of
      // something absent is better served by the closest sentence plus a weight
      // than by silence.
      const spans = (ranked[0]?.weight ?? 0) > 0
        ? ranked.filter((row) => row.weight > 0).slice(0, 3)
        : ranked.slice(0, 1);
      for (const row of spans) state.foundSpanIds.add(row.span.spanId);
      return ok({
        spans: spans.map((row) => ({ ...row.span, matchedTerms: row.weight })),
      });
    }

    case 'scan_prompt_injection': {
      const missing = needsSubmission();
      if (missing) return missing;
      return ok({ findings: injectionFindings(submissionId!) });
    }

    case 'check_eligibility': {
      const missing = needsSubmission();
      if (missing) return missing;
      return ok({
        eligible: facts!.eligible,
        rules: eligibilityVerdicts(submissionId!),
        ...(facts!.ineligibleReason ? { failing: facts!.ineligibleReason } : {}),
      });
    }

    case 'compare_submissions': {
      const missing = needsSubmission();
      if (missing) return missing;
      const otherId = asString(args.otherSubmissionId);
      if (!otherId) return bad('invalid_argument', '"otherSubmissionId" is required');
      const other = catalogById.get(otherId);
      if (!other) return bad('not_found', `No submission "${otherId}"`);

      // Public facts, plus whatever this reviewer has scored in this session.
      // The judges' scores are not in this bundle and never will be.
      const side = (id: string) => {
        const entry = catalogById.get(id)!;
        const entryFacts = appFactsById.get(id)!;
        return {
          id,
          title: entry.title,
          track: entry.track,
          declaredStack: entry.declaredStack,
          detectedStack: entryFacts.actualStack,
          eligible: entryFacts.eligible,
          scoresRecordedHere: state.scoresThisSession.get(id) ?? {},
        };
      };
      return ok({ criteria: CRITERIA, submissions: [side(submissionId!), side(otherId)] });
    }

    case 'score_submission': {
      const missing = needsSubmission();
      if (missing) return missing;
      const criterion = asString(args.criterion);
      const rawScore = args.score;
      // Both checks are the same on every manifest version. v2 stopped
      // documenting them; it never stopped enforcing them.
      if (!criterion || !CRITERIA.includes(criterion as Criterion)) {
        return bad('invalid_argument', '"criterion" is not a rubric criterion');
      }
      if (typeof rawScore !== 'number' || !Number.isInteger(rawScore) || rawScore < 1 || rawScore > 10) {
        return bad('invalid_argument', '"score" must be an integer from 1 to 10');
      }
      const recorded = state.scoresThisSession.get(submissionId!) ?? {};
      recorded[criterion as Criterion] = rawScore;
      state.scoresThisSession.set(submissionId!, recorded);
      return ok({ recorded: true, submissionId, criterion, score: rawScore });
    }

    case 'highlight_evidence': {
      const missing = needsSubmission();
      if (missing) return missing;
      const spanId = asString(args.spanId);
      if (!spanId) return bad('invalid_argument', '"spanId" is required');
      // The precondition v1 documented and v2 stopped mentioning.
      if (!state.foundSpanIds.has(spanId)) {
        return bad('precondition_failed', 'No such spanId — call find_evidence first');
      }
      return ok({ highlighted: spanId });
    }

    case 'build_shortlist': {
      const missing = needsSubmission();
      if (missing) return missing;
      const track = asString(args.track);
      if (!track || !TRACKS.includes(track as Track)) {
        return bad('invalid_argument', `"track" must be one of: ${TRACKS.join(', ')}`);
      }
      return ok({ shortlisted: submissionId, track });
    }

    case 'flag_submission': {
      const missing = needsSubmission();
      if (missing) return missing;
      const reason = asString(args.reason);
      if (!reason) return bad('invalid_argument', '"reason" is required');
      return ok({ flagged: submissionId, reason });
    }

    case 'add_review_note': {
      const missing = needsSubmission();
      if (missing) return missing;
      const note = asString(args.note);
      if (!note) return bad('invalid_argument', '"note" is required');
      return ok({ noted: submissionId });
    }

    case 'open_submission': {
      const missing = needsSubmission();
      if (missing) return missing;
      return ok({ opened: submissionId });
    }

    case 'get_review_queue': {
      const track = asString(args.track);
      if (track && !TRACKS.includes(track as Track)) {
        return bad('invalid_argument', `"track" must be one of: ${TRACKS.join(', ')}`);
      }
      const pending = catalog
        .filter((entry) => !track || entry.track === track)
        .filter((entry) => Object.keys(state.scoresThisSession.get(entry.id) ?? {}).length < CRITERIA.length)
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .map((entry) => ({ id: entry.id, title: entry.title, track: entry.track }));
      return ok({ pending, total: pending.length });
    }

    default:
      // A tool the console has never offered. This is what a hallucinated call
      // hits, in the app and in the generator alike.
      return bad('unknown_tool', `No tool named ${functionName}`);
  }
}
