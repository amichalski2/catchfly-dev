/**
 * Checks that the console can actually do everything it advertises.
 *
 * The app builds its tool surface by zipping a manifest with one backend, so
 * the failure this catches is specific and quiet: a manifest that declares a
 * tool `execute()` has never heard of. The app would register it, an agent
 * would call it, and the answer would be "no tool named …" from the very page
 * that just offered it.
 *
 * It also pins the behaviours the eval matrix depends on: that the backend
 * enforces the same contract on every version — which is what makes the v2
 * regression a documentation failure rather than a code change — and that the
 * results are honest enough to be worth evaluating against.
 *
 * Run with: npm run smoke
 */

import { catalog, CRITERIA } from '@catchfly/devpost-world/catalog.ts';
import { execute, newSessionState } from '@catchfly/devpost-world/results.ts';
import { APP_VERSIONS, manifestFor, PHANTOM_TOOLS } from '@catchfly/devpost-world/tools.ts';

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

/** Arguments good enough to get each tool past its own validation. */
const SAMPLE: Record<string, Record<string, unknown>> = {
  get_rubric: {},
  search_submissions: { query: 'agent' },
  list_submissions: {},
  get_submission: { submissionId: 'DEV-1001' },
  inspect_readme: { submissionId: 'DEV-1001' },
  inspect_repository: { submissionId: 'DEV-1001' },
  detect_stack: { submissionId: 'DEV-1001' },
  verify_technology_claim: { submissionId: 'DEV-1001', technology: 'WebMCP' },
  find_evidence: { submissionId: 'DEV-1001', claim: 'browser tabs' },
  scan_prompt_injection: { submissionId: 'DEV-1009' },
  flag_submission: { submissionId: 'DEV-1009', reason: 'injection' },
  check_eligibility: { submissionId: 'DEV-1029' },
  compare_submissions: { submissionId: 'DEV-1005', otherSubmissionId: 'DEV-1017' },
  score_submission: { submissionId: 'DEV-1001', criterion: 'innovation', score: 7 },
  build_shortlist: { submissionId: 'DEV-1001', track: 'Agent Experience' },
  open_submission: { submissionId: 'DEV-1001' },
  add_review_note: { submissionId: 'DEV-1001', note: 'looks fine' },
  highlight_evidence: { submissionId: 'DEV-1001', spanId: 'resolved-below' },
  get_review_queue: {},
};

heading('every declared tool has behaviour');

for (const version of APP_VERSIONS) {
  const manifest = manifestFor(version.id);
  const missing: string[] = [];
  for (const tool of manifest) {
    const state = newSessionState();
    let args = SAMPLE[tool.name];
    if (!args) {
      missing.push(`${tool.name} (no sample arguments in this test)`);
      continue;
    }
    if (tool.name === 'highlight_evidence') {
      // Has a precondition by design; satisfy it the way an agent would.
      const found = execute('find_evidence', { submissionId: 'DEV-1001', claim: 'tabs' }, state);
      const spanId = found.ok
        ? (found.value as { spans: Array<{ spanId: string }> }).spans[0]?.spanId
        : undefined;
      args = { submissionId: 'DEV-1001', spanId: spanId ?? 'missing' };
    }
    const outcome = execute(tool.name, args, state);
    if (!outcome.ok && outcome.errorType === 'unknown_tool') missing.push(tool.name);
  }
  check(`${version.id} declares nothing the backend cannot serve`, missing.length === 0,
    missing.length === 0 ? `${manifest.length} tools` : missing.join(', '));
}

check(
  'the tools this world calls phantom really are undeclared',
  PHANTOM_TOOLS.every((name) => APP_VERSIONS.every((version) => !manifestFor(version.id).some((tool) => tool.name === name))),
  PHANTOM_TOOLS.join(', '),
);

// --- the contract does not move between versions -----------------------
//
// This is the mechanism of the whole demo. v2 documents four tools worse; it
// must not accept anything v1 rejected, or the regression would be a code
// change rather than a documentation failure.

heading('the contract is the same on every version');

for (const version of APP_VERSIONS) {
  const state = newSessionState();
  const outOfRange = execute('score_submission', { submissionId: 'DEV-1001', criterion: 'innovation', score: 70 }, state);
  const badCriterion = execute('score_submission', { submissionId: 'DEV-1001', criterion: 'technical', score: 7 }, state);
  const unlooked = execute('highlight_evidence', { submissionId: 'DEV-1001', spanId: 'DEV-1001-span-1' }, state);

  check(
    `${version.id} rejects a score outside 1-10`,
    !outOfRange.ok && outOfRange.errorType === 'invalid_argument',
    !outOfRange.ok ? outOfRange.message : 'accepted it',
  );
  check(
    `${version.id} rejects a criterion the rubric does not name`,
    !badCriterion.ok && badCriterion.errorType === 'invalid_argument',
  );
  check(
    `${version.id} refuses a highlight before its lookup`,
    !unlooked.ok && unlooked.errorType === 'precondition_failed',
  );
}

// --- the answers are worth evaluating against --------------------------

heading('the backend answers honestly');

const state = newSessionState();

const searched = execute('search_submissions', { query: 'meeting rooms' }, state);
check(
  'search finds the submission it describes',
  searched.ok && (searched.value as { matches: Array<{ id: string }> }).matches[0]?.id === 'DEV-1020',
  searched.ok ? (searched.value as { matches: Array<{ id: string }> }).matches.map((m) => m.id).join(',') : 'failed',
);

const tracked = execute('search_submissions', { query: 'agent', track: 'Commerce' }, state);
check(
  'search honours the track filter',
  tracked.ok &&
    (tracked.value as { matches: Array<{ track: string }> }).matches.every((m) => m.track === 'Commerce'),
);

const limited = execute('search_submissions', { query: 'a', limit: 2 }, state);
check('search honours the limit', limited.ok && (limited.value as { matches: unknown[] }).matches.length <= 2);

const eligible = execute('list_submissions', { eligibleOnly: true }, state);
check(
  'eligibleOnly actually filters',
  eligible.ok && (eligible.value as { total: number }).total < catalog.length,
  eligible.ok ? `${(eligible.value as { total: number }).total} of ${catalog.length}` : 'failed',
);

const claim = execute('verify_technology_claim', { submissionId: 'DEV-1004', technology: 'WebMCP' }, state);
check(
  'a declared-but-absent technology comes back unconfirmed',
  claim.ok && (claim.value as { declared: boolean; confirmed: boolean }).declared === true &&
    (claim.value as { confirmed: boolean }).confirmed === false,
);

const scan = execute('scan_prompt_injection', { submissionId: 'DEV-1009' }, state);
check('a planted instruction is found', scan.ok && (scan.value as { findings: unknown[] }).findings.length === 1);
const clean = execute('scan_prompt_injection', { submissionId: 'DEV-1001' }, state);
check('a clean description reports nothing', clean.ok && (clean.value as { findings: unknown[] }).findings.length === 0);

const rules = execute('check_eligibility', { submissionId: 'DEV-1029' }, state);
check(
  'the submission with no demo fails on the demo rule',
  rules.ok &&
    (rules.value as { eligible: boolean; rules: Array<{ rule: string; passed: boolean }> }).eligible === false &&
    (rules.value as { rules: Array<{ rule: string; passed: boolean }> }).rules.some(
      (entry) => entry.rule.includes('demo') && !entry.passed,
    ),
);

const evidence = execute('find_evidence', { submissionId: 'DEV-1003', claim: 'accessibility tree' }, state);
const spanId = evidence.ok ? (evidence.value as { spans: Array<{ spanId: string; quote: string }> }).spans[0] : null;
check('evidence comes back as a quotable span', spanId !== null && spanId.quote.length > 0, spanId?.quote);
check(
  'a looked-up span can then be highlighted',
  execute('highlight_evidence', { submissionId: 'DEV-1003', spanId: spanId!.spanId }, state).ok,
);
check(
  'span ids are stable across sessions',
  (() => {
    const other = newSessionState();
    const again = execute('find_evidence', { submissionId: 'DEV-1003', claim: 'accessibility tree' }, other);
    return again.ok && (again.value as { spans: Array<{ spanId: string }> }).spans[0]?.spanId === spanId!.spanId;
  })(),
);

// A comparison may show what this reviewer recorded, and nothing a judge knows.
execute('score_submission', { submissionId: 'DEV-1005', criterion: 'impact', score: 6 }, state);
const compared = execute('compare_submissions', { submissionId: 'DEV-1005', otherSubmissionId: 'DEV-1017' }, state);
check(
  'a comparison shows scores recorded here',
  compared.ok &&
    (compared.value as { submissions: Array<{ scoresRecordedHere: Record<string, number> }> }).submissions[0]
      .scoresRecordedHere.impact === 6,
);
check(
  'and nothing for the submission nobody has scored',
  compared.ok &&
    Object.keys(
      (compared.value as { submissions: Array<{ scoresRecordedHere: Record<string, number> }> }).submissions[1]
        .scoresRecordedHere,
    ).length === 0,
  'DEV-1017 has judged scores in the world; a comparison must not know them',
);

const queue = execute('get_review_queue', {}, state);
check(
  'the review queue leaves out nothing that is still unscored',
  queue.ok && (queue.value as { total: number }).total === catalog.length,
  queue.ok ? `${(queue.value as { total: number }).total} pending` : 'failed',
);

const scoredAll = newSessionState();
for (const criterion of CRITERIA) {
  execute('score_submission', { submissionId: 'DEV-1001', criterion, score: 5 }, scoredAll);
}
const shorter = execute('get_review_queue', {}, scoredAll);
check(
  'a fully scored submission drops out of the queue',
  shorter.ok && (shorter.value as { total: number }).total === catalog.length - 1,
);

const nowhere = execute('get_submission', { submissionId: 'DEV-9999' }, state);
check('an unknown submission is refused, not invented', !nowhere.ok && nowhere.errorType === 'not_found');

console.log();
if (failures.length > 0) {
  console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\x1b[32mAll console backend checks passed.\x1b[0m\n');
