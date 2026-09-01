/**
 * Verifies the Chrome WebMCP Evals adapter against reports shaped the way the
 * CLI writes them — including the multi-step case that would otherwise import
 * as several look-alike cases.
 *
 * Run with: npm run smoke
 */

import { readFileSync } from 'node:fs';

import { adaptChromeReport, ImportError, type ChromeReport } from '@catchfly/eval-adapters/chrome.ts';
import { mergeRun, runIdFor } from '@catchfly/eval-adapters/merge.ts';
import { createDb } from '@catchfly/core/db.ts';
import { findRegressions, listRuns } from '@catchfly/core/queries.ts';
import { CHROME_REPORT_PATH, loadTestDb, TEST_RUN_BASELINE, TEST_RUN_CANDIDATE } from './test-io.ts';

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const TOOLS = [
  { name: 'search_catalog', description: 'Search the catalog.', parameters: { type: 'object' } },
  { name: 'get_product', description: 'Read one product.', parameters: { type: 'object' } },
  { name: 'add_to_cart', description: 'Add to cart.', parameters: { type: 'object' } },
  { name: 'find_product', description: 'Find a product.', parameters: { type: 'object' } },
];

/** One single-step case, run twice, plus one two-step case. */
const REPORT: ChromeReport = {
  config: { backend: 'gemini', model: 'gemini-3.5-flash', chromeChannel: 'chrome-canary' },
  results: {
    testCount: 4,
    passCount: 2,
    failCount: 2,
    errorCount: 0,
    results: [
      {
        test: {
          name: 'Search shoes under $120',
          messages: [{ role: 'user', type: 'message', content: "I'm looking for running shoes under $120." }],
          expectedCall: [{ functionName: 'search_catalog', arguments: { query: { $contains: 'running' } } }],
        },
        outcome: 'pass',
        runIndex: 1,
        trajectory: [
          {
            reasoningText: 'Searching.',
            toolCalls: [{ functionName: 'search_catalog', args: { query: 'running shoes', maxPrice: 120 } }],
            toolResults: [{ matches: 4 }],
            availableTools: TOOLS,
          },
        ],
      },
      {
        test: {
          name: 'Search shoes under $120',
          messages: [{ role: 'user', type: 'message', content: "I'm looking for running shoes under $120." }],
          expectedCall: [{ functionName: 'search_catalog', arguments: { query: { $contains: 'running' } } }],
        },
        outcome: 'fail',
        runIndex: 2,
        trajectory: [
          {
            toolCalls: [{ functionName: 'find_product', args: { name: 'running shoes' } }],
            toolResults: [{ error: 'no exact match' }],
            availableTools: TOOLS,
          },
        ],
      },
      // A tool the page never registered — a different failure entirely.
      {
        test: {
          name: 'Show me the cart',
          messages: [{ role: 'user', type: 'message', content: 'Show me my cart.' }],
          expectedCall: [{ functionName: 'get_cart' }],
        },
        outcome: 'fail',
        runIndex: 1,
        trajectory: [
          {
            toolCalls: [{ functionName: 'searchProducts', args: {} }],
            toolResults: [{ error: 'no such tool' }],
            availableTools: TOOLS,
          },
        ],
      },
      // One case, two turns — Chrome scores each step separately.
      {
        test: {
          name: 'Add the cheapest keyboard',
          messages: [{ role: 'user', type: 'message', content: 'Add the cheapest keyboard to my cart.' }],
          expectedCall: [
            { ordered: [{ functionName: 'search_catalog' }, { functionName: 'add_to_cart' }] },
          ],
        },
        outcome: 'pass',
        runIndex: 1,
        stepIndex: 0,
        trajectory: [
          {
            toolCalls: [{ functionName: 'search_catalog', args: { query: 'keyboard' } }],
            toolResults: [{ topSku: 'sku-1187' }],
            availableTools: TOOLS,
          },
        ],
      },
      {
        test: {
          name: 'Add the cheapest keyboard',
          messages: [{ role: 'user', type: 'message', content: 'Add the cheapest keyboard to my cart.' }],
          expectedCall: [
            { ordered: [{ functionName: 'search_catalog' }, { functionName: 'add_to_cart' }] },
          ],
        },
        outcome: 'fail',
        runIndex: 1,
        stepIndex: 1,
        trajectory: [
          {
            toolCalls: [{ functionName: 'add_to_cart', args: { productId: '', quantity: 1 } }],
            toolResults: [{ error: 'unknown productId' }],
            availableTools: TOOLS,
          },
        ],
      },
    ],
  },
};

console.log('\n\x1b[1mChrome report adapter\x1b[0m');

const adapted = adaptChromeReport(REPORT, {
  appVersionId: 'imported-v1',
  runId: 'run-imported-v1',
  timestamp: '2026-08-26T09:00:00.000Z',
});

check('two-step case not split into extra cases', adapted.cases.length === 3, `${adapted.cases.length} cases`);
check(
  'the two-step case folded into one attempt',
  adapted.run.results.length === 4,
  `${adapted.run.results.length} attempts`,
);

const multiStep = adapted.run.results.find((result) => result.caseId === 'add-the-cheapest-keyboard');
check('folded attempt takes the worst outcome', multiStep?.outcome === 'fail', multiStep?.outcome);
check(
  'folded attempt concatenates calls in step order',
  multiStep?.actualCalls.map((call) => call.functionName).join(' → ') ===
    'search_catalog → add_to_cart',
  multiStep?.actualCalls.map((call) => call.functionName).join(' → '),
);
check(
  'tool results paired with their calls',
  (multiStep?.actualCalls[1].result as { error?: string })?.error === 'unknown productId',
);

const regressed = adapted.run.results.find(
  (result) => result.caseId === 'search-shoes-under-120' && result.runIndex === 2,
);
check(
  'classified as a tool-selection failure',
  regressed?.category === 'tool-selection',
  regressed?.category,
);
const hallucinated = adapted.run.results.find((result) => result.caseId === 'show-me-the-cart');
check(
  'a tool absent from the manifest is a hallucination, not a mis-selection',
  hallucinated?.category === 'hallucinated-tool',
  hallucinated?.category,
);

check(
  'latency and cost stay absent, not zero',
  adapted.run.results.every(
    (result) => result.latencyMs === undefined && result.costUsd === undefined,
  ),
);
check(
  'metrics omit what Chrome does not measure',
  adapted.run.metrics.avgLatencyMs === undefined && adapted.run.metrics.totalCostUsd === undefined,
);
check(
  'success rate computed over folded attempts',
  Math.abs(adapted.run.metrics.successRate - 1 / 4) < 1e-9,
  `${(adapted.run.metrics.successRate * 100).toFixed(1)}%`,
);
check('manifest recovered from availableTools', adapted.toolManifest.length === 4);

console.log('\n\x1b[1mbad input\x1b[0m');
for (const [label, input] of [
  ['not a report', {} as ChromeReport],
  ['empty results', { results: { results: [] } } as ChromeReport],
]) {
  try {
    adaptChromeReport(input as ChromeReport, {
      appVersionId: 'x',
      runId: 'x',
      timestamp: '2026-08-26T09:00:00.000Z',
    });
    check(`${label} rejected`, false, 'no error thrown');
  } catch (error: unknown) {
    check(`${label} rejected with guidance`, error instanceof ImportError, (error as Error).message.slice(0, 60));
  }
}

console.log('\n\x1b[1mmerge into the active dataset\x1b[0m');
const db = loadTestDb();
const before = db.dataset.runs.length;
const merged = mergeRun(db.dataset, {
  ...adapted,
  appVersionLabel: 'imported-v1',
});
const mergedDb = createDb(merged);

check('run added', mergedDb.dataset.runs.length === before + 1, `${mergedDb.dataset.runs.length} runs`);
check('app version created', mergedDb.versionsById.has('imported-v1'));
check(
  'existing runs untouched',
  mergedDb.runsById.get(TEST_RUN_BASELINE)?.metrics.passCount === 36,
  `${mergedDb.runsById.get(TEST_RUN_BASELINE)?.metrics.passCount} passes`,
);
check('imported run listed', listRuns(mergedDb).some((run) => run.runId === 'run-imported-v1'));
check(
  'imported cases queryable alongside the existing data',
  mergedDb.casesById.has('add-the-cheapest-keyboard') && mergedDb.casesById.has('case-01'),
);

// Re-importing the same file must replace the run, not duplicate it.
const again = createDb(mergeRun(merged, { ...adapted, appVersionLabel: 'imported-v1' }));
check('re-import replaces rather than duplicates', again.dataset.runs.length === before + 1);
check('stable run id', runIdFor('app-v9', 'gemini-3.5-flash') === 'run-app-v9-gemini-3-5-flash');

const cross = findRegressions(mergedDb, TEST_RUN_BASELINE, TEST_RUN_CANDIDATE);
check('regression queries still work after a merge', cross.regressedAttempts === 23);

console.log('\n\x1b[1mround trip: a report this suite generated\x1b[0m');
try {
  const sample = JSON.parse(readFileSync(CHROME_REPORT_PATH, 'utf8')) as ChromeReport;
  const roundTripped = adaptChromeReport(sample, {
    appVersionId: 'sample',
    runId: 'run-sample',
    timestamp: '2026-08-26T09:00:00.000Z',
  });
  check(
    'sample report parses back into runs and cases',
    roundTripped.cases.length > 0 && roundTripped.run.results.length > 0,
    `${roundTripped.cases.length} cases · ${roundTripped.run.results.length} attempts`,
  );
  check(
    'every failure in the sample is classified',
    roundTripped.run.results
      .filter((result) => result.outcome !== 'pass')
      .every((result) => result.category !== undefined),
  );
  check('sample carries a tool manifest', roundTripped.toolManifest.length > 0);
} catch (error: unknown) {
  check('sample report round trip', false, (error as Error).message);
}

console.log();
if (failures.length > 0) {
  console.error(`\x1b[31m${failures.length} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\x1b[32mAll import checks passed.\x1b[0m\n');
