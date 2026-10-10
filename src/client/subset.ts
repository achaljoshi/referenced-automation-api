/**
 * Where `actual` fails to contain everything `expected` says - an empty list means it does. Objects match when every
 * key in `expected` matches (extra keys in `actual` are fine); arrays must be the same length with matching items;
 * everything else is compared with ===. The ids, timestamps and extras an API adds do not break an assertion that
 * is only about the fields you care about.
 */
export function subsetDifferences(actual: unknown, expected: unknown, path = '$'): string[] {
  if (expected !== null && typeof expected === 'object') {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return [`${path}: expected an array, got ${describe(actual)}`];
      if (actual.length !== expected.length)
        return [`${path}: expected ${expected.length} item(s), got ${actual.length}`];
      return expected.flatMap((item, index) =>
        subsetDifferences(actual[index], item, `${path}[${index}]`),
      );
    }
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual))
      return [`${path}: expected an object, got ${describe(actual)}`];
    return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) => {
      const child = `${path}.${key}`;
      if (!(key in (actual as Record<string, unknown>))) return [`${child}: missing`];
      return subsetDifferences((actual as Record<string, unknown>)[key], value, child);
    });
  }
  return actual === expected
    ? []
    : [`${path}: expected ${describe(expected)}, got ${describe(actual)}`];
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

/** Replaces the values at the given keys (at any depth) so volatile fields - ids, timestamps - do not make a stored snapshot flap. */
export function maskFields<T>(value: T, keys: Array<string | RegExp>, placeholder = '<masked>'): T {
  const matches = (key: string) =>
    keys.some((k) => (typeof k === 'string' ? k === key : k.test(key)));
  if (Array.isArray(value))
    return value.map((item) => maskFields(item, keys, placeholder)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        matches(key) ? placeholder : maskFields(item, keys, placeholder),
      ]),
    ) as T;
  }
  return value;
}
