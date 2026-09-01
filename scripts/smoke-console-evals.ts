/**
 * Validates the Devpost console eval suite offline, against all three manifests.
 *
 * A run of this suite costs money and about ten minutes of browser time, so
 * every mistake that can be caught by reading the tool schemas should be caught
 * before the browser starts: a tool name that no version declares, an argument
 * key that is not in the schema, an enum value the tool would reject, a
 * submission id that is not in the catalog.
 *
 * The three-manifest check is the one that matters most here. The whole point
 * of the matrix is running the *same* suite against v1, v2 and v3, so a case
 * requiring a tool only v3 declares would fail on the other two for a reason
 * that has nothing to do with what is being measured.
 *
 * Run with: npm run smoke
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExpectedCallNode, ExpectedFunctionCall } from '@catchfly/core/types.ts';
import { catalogById, CRITERIA, TRACKS } from '@catchfly/devpost-world/catalog.ts';
import { APP_VERSIONS, manifestFor } from '@catchfly/devpost-world/tools.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SUITE_PATH = resolve(here, '../evals/devpost-console.evals.json');

type SuiteCase = {
  name: string;
  messages: Array<{ role: string; type: string; content: string }>;
  expectedCall: ExpectedCallNode[];
};

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`);

let suite: SuiteCase[];
try {
  suite = JSON.parse(readFileSync(SUITE_PATH, 'utf8')) as SuiteCase[];
} catch {
  console.log('\n\x1b[33mMissing evals/devpost-console.evals.json.\x1b[0m\n');
  process.exit(0);
}

// --- what each version declares ----------------------------------------

/** name -> argument schema, per version. */
const schemas = new Map<string, Map<string, Record<string, unknown>>>();
for (const version of APP_VERSIONS) {
  const byName = new Map<string, Record<string, unknown>>();
  for (const tool of manifestFor(version.id)) {
    byName.set(tool.name, (tool.inputSchema?.properties as Record<string, unknown>) ?? {});
  }
  schemas.set(version.id, byName);
}

const versionIds = APP_VERSIONS.map((version) => version.id);
/** Tools every version declares — the only ones a required call may name. */
const shared = [...(schemas.get(versionIds[0]) ?? new Map()).keys()].filter((name) =>
  versionIds.every((id) => schemas.get(id)!.has(name)),
);

heading('manifests');
check('every version declares tools', versionIds.every((id) => (schemas.get(id)?.size ?? 0) > 0));
check('the shared surface is the eighteen', shared.length === 18, `${shared.length} tools in all three`);
check(
  'the newest version adds something',
  (schemas.get(versionIds[2])?.size ?? 0) > shared.length,
  `${schemas.get(versionIds[2])?.size} in ${versionIds[2]}`,
);

// --- walking the expectations ------------------------------------------

type Node = { call: ExpectedFunctionCall; required: boolean };

function flatten(nodes: ExpectedCallNode[], required = true): Node[] {
  const out: Node[] = [];
  for (const node of nodes) {
    if ('ordered' in node) out.push(...flatten(node.ordered, required));
    else if ('unordered' in node) out.push(...flatten(node.unordered, required));
    else out.push({ call: node, required: required && node.optional !== true });
  }
  return out;
}

/** A value that is a matcher constrains rather than states — no literal to check. */
const literalOf = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > 0 && keys.every((key) => key.startsWith('$'))) return undefined;
  }
  return value;
};

heading(`suite — ${suite.length} cases`);

const exercised = new Set<string>();
let problems = 0;

for (const [index, testCase] of suite.entries()) {
  const label = testCase.name || `case #${index + 1}`;
  const nodes = flatten(testCase.expectedCall);
  const report = (message: string) => {
    problems += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} — ${message}`);
  };

  if (!testCase.messages?.[0]?.content) report('has no user message');
  if (nodes.length === 0) report('expects no calls');
  if (nodes.length > 0 && !nodes.some((node) => node.required)) {
    // Every node optional means the case passes without the agent doing
    // anything, which measures nothing at all.
    report('every expected call is optional, so it cannot fail');
  }

  for (const { call, required } of nodes) {
    exercised.add(call.functionName);

    // A required call must exist on every version; an optional one only has to
    // exist somewhere, since v3 declares one tool the others do not.
    const missingFrom = versionIds.filter((id) => !schemas.get(id)!.has(call.functionName));
    if (required && missingFrom.length > 0) {
      report(`requires "${call.functionName}", which ${missingFrom.join(' and ')} do not declare`);
      continue;
    }
    if (missingFrom.length === versionIds.length) {
      report(`names "${call.functionName}", which no version declares`);
      continue;
    }

    for (const [key, value] of Object.entries(call.arguments ?? {})) {
      for (const id of versionIds) {
        const properties = schemas.get(id)!.get(call.functionName);
        if (!properties) continue;
        if (!(key in properties)) {
          report(`passes "${key}" to ${call.functionName}, which ${id} does not accept`);
          continue;
        }
        const literal = literalOf(value);
        if (literal === undefined) continue;
        const schema = properties[key] as { enum?: unknown[] };
        if (Array.isArray(schema.enum) && !schema.enum.includes(literal)) {
          report(`passes ${JSON.stringify(literal)} to ${call.functionName}.${key}, which ${id} does not allow`);
        }
      }

      // World-level literals: an id or a track that does not exist makes the
      // case unanswerable however well the agent behaves.
      const literal = literalOf(value);
      if (key === 'submissionId' || key === 'otherSubmissionId') {
        if (typeof literal === 'string' && !catalogById.has(literal)) {
          report(`names submission "${literal}", which is not in the catalog`);
        }
      }
      if (key === 'track' && typeof literal === 'string' && !TRACKS.includes(literal as never)) {
        report(`names track "${literal}", which does not exist`);
      }
      if (key === 'criterion' && typeof literal === 'string' && !CRITERIA.includes(literal as never)) {
        report(`names criterion "${literal}", which is not in the rubric`);
      }
    }

    // The one assertion a suite must never make: a judged score.
    if (call.functionName === 'score_submission') {
      const score = call.arguments?.score;
      if (typeof score === 'number') {
        report('asserts a literal score — a judgement the agent has no way to derive; use a range matcher');
      }
    }
  }
}

check('every case is well-formed', problems === 0, problems === 0 ? '' : `${problems} problem(s) above`);

heading('coverage');
const uncovered = shared.filter((name) => !exercised.has(name));
check(
  'every shared tool is exercised by the suite',
  uncovered.length === 0,
  uncovered.length === 0 ? `${shared.length} tools` : `missing: ${uncovered.join(', ')}`,
);

console.log();
if (failures.length > 0 || problems > 0) {
  console.error(`\x1b[31m${failures.length + problems} check(s) failed:\x1b[0m`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\x1b[32mAll console eval checks passed.\x1b[0m\n');
