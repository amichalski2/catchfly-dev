/**
 * Argument matching, compatible with the operators the Chrome WebMCP Evals CLI
 * accepts inside `expectedCall[].arguments`: $pattern, $contains, $gt, $gte,
 * $lt, $lte, $type, $any.
 *
 * Used both by the fixture generator (to classify failures) and by the future
 * Chrome report importer, so both agree on what "wrong arguments" means.
 */

type Constraint = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConstraint(value: unknown): value is Constraint {
  return isPlainObject(value) && Object.keys(value).some((key) => key.startsWith('$'));
}

function matchConstraint(constraint: Constraint, actual: unknown): boolean {
  return Object.entries(constraint).every(([operator, operand]) => {
    switch (operator) {
      case '$any':
        return actual !== undefined;
      case '$pattern':
        return typeof actual === 'string' && new RegExp(String(operand)).test(actual);
      case '$contains':
        if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, operand));
        return typeof actual === 'string' && actual.includes(String(operand));
      case '$gt':
        return typeof actual === 'number' && actual > Number(operand);
      case '$gte':
        return typeof actual === 'number' && actual >= Number(operand);
      case '$lt':
        return typeof actual === 'number' && actual < Number(operand);
      case '$lte':
        return typeof actual === 'number' && actual <= Number(operand);
      case '$type':
        return typeof actual === String(operand);
      default:
        // Unknown operators are treated as literal keys of a nested object.
        return isPlainObject(actual) && matchValue(operand, actual[operator]);
    }
  });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

function matchValue(expected: unknown, actual: unknown): boolean {
  if (isConstraint(expected)) return matchConstraint(expected, actual);
  if (isPlainObject(expected) && isPlainObject(actual)) return matchArgs(expected, actual);
  return deepEqual(expected, actual);
}

/**
 * True when `actual` satisfies every key of `expected`.
 * A null/undefined expectation imposes no constraint (Chrome semantics).
 * Extra keys in `actual` are allowed.
 */
export function matchArgs(
  expected: Record<string, unknown> | null | undefined,
  actual: Record<string, unknown> | undefined,
): boolean {
  if (expected === null || expected === undefined) return true;
  if (!actual) return Object.keys(expected).length === 0;
  return Object.entries(expected).every(([key, value]) => matchValue(value, actual[key]));
}

/** True when the tool's execution result satisfies the expectation. */
export function matchResult(expected: unknown, actual: unknown): boolean {
  if (expected === undefined) return true;
  return matchValue(expected, actual);
}
