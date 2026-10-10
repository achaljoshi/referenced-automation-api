import type { APIResponse } from '@playwright/test';
import {
  getPath,
  hasPath,
  requirePath,
  validateSchema,
  type SchemaValidationResult,
} from '@automation/referenced-automation-utils';
import { fromXml } from './xml';
import { maskFields, subsetDifferences } from './subset';
import type { Exchange } from './exchange';

/**
 * Wraps Playwright's APIResponse with the body already read and parsed
 * (JSON, XML, or left as text, based on Content-Type), and dot/bracket path
 * traversal for assertions: response.get('data.users[0].name'),
 * response.get('items[2].id'). Every ApiClient method returns this, already
 * awaited - no separate `.json()` call needed before you can assert on it.
 */
export class ApiResponse {
  readonly raw: APIResponse;
  private readonly parsedBody: unknown;
  private readonly rawText: string;
  /** How long the call took, in milliseconds (the last attempt, when retries were involved). Set by ApiClient; 0 for a response wrapped by hand. */
  readonly durationMs: number;
  /** The request/response record, when the response came from an ApiClient call - for `toCurl` and reports. */
  readonly exchange?: Exchange;

  private constructor(
    raw: APIResponse,
    parsedBody: unknown,
    rawText: string,
    durationMs: number,
    exchange?: Exchange,
  ) {
    this.raw = raw;
    this.parsedBody = parsedBody;
    this.rawText = rawText;
    this.durationMs = durationMs;
    this.exchange = exchange;
  }

  static async from(
    raw: APIResponse,
    meta: { durationMs?: number; exchange?: Exchange } = {},
  ): Promise<ApiResponse> {
    const rawText = await raw.text();
    const contentType = raw.headers()['content-type'] ?? '';

    let parsedBody: unknown = rawText;
    if (rawText.length > 0) {
      if (contentType.includes('json')) {
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          parsedBody = rawText;
        }
      } else if (contentType.includes('xml')) {
        try {
          parsedBody = fromXml(rawText);
        } catch {
          parsedBody = rawText;
        }
      }
    }

    return new ApiResponse(raw, parsedBody, rawText, meta.durationMs ?? 0, meta.exchange);
  }

  status(): number {
    return this.raw.status();
  }

  statusText(): string {
    return this.raw.statusText();
  }

  ok(): boolean {
    return this.raw.ok();
  }

  headers(): Record<string, string> {
    return this.raw.headers();
  }

  header(name: string): string | undefined {
    return this.raw.headers()[name.toLowerCase()];
  }

  /** The raw response bytes - for downloads and binary content, where `text()` would corrupt them. */
  async bytes(): Promise<Buffer> {
    return this.raw.body();
  }

  /** Every `Set-Cookie` the response sent, parsed: name, value and the attributes (Path, Domain, HttpOnly, ...). */
  cookies(): ResponseCookie[] {
    return this.raw
      .headersArray()
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => parseSetCookie(header.value));
  }

  /** The parsed body (object for JSON/XML, string otherwise). */
  body<T = unknown>(): T {
    return this.parsedBody as T;
  }

  text(): string {
    return this.rawText;
  }

  /** Dot/bracket path read on the parsed body, e.g. response.get('data[0].name'). */
  get<T = unknown>(path: string, defaultValue?: T): T {
    return getPath<T>(this.parsedBody, path, defaultValue);
  }

  has(path: string): boolean {
    return hasPath(this.parsedBody, path);
  }

  /** Like get(), but throws a readable error if the path is absent. */
  require<T = unknown>(path: string): T {
    return requirePath<T>(this.parsedBody, path);
  }

  validateSchema(schema: object): SchemaValidationResult {
    return validateSchema(this.parsedBody, schema);
  }

  // ---- fluent assertions - throw with a readable message, for chains that
  // don't want to import `expect` for a quick sanity check. Prefer
  // Playwright's own `expect(response.status()).toBe(200)` in real specs -
  // these exist for readability in helper functions/fixtures. ----

  expectStatus(expected: number): this {
    if (this.status() !== expected) {
      throw new Error(
        `Expected status ${expected} but got ${this.status()} (${this.statusText()})\nBody: ${this.rawText.slice(0, 1000)}`,
      );
    }
    return this;
  }

  expectStatusInRange(min: number, max: number): this {
    if (this.status() < min || this.status() > max) {
      throw new Error(
        `Expected status in [${min}, ${max}] but got ${this.status()}\nBody: ${this.rawText.slice(0, 1000)}`,
      );
    }
    return this;
  }

  expectValue(path: string, expected: unknown): this {
    const actual = this.get(path);
    if (actual !== expected) {
      throw new Error(
        `Expected "${path}" to be ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
      );
    }
    return this;
  }

  /** The header is present and (when given) equals the string or matches the pattern. Header names are case-insensitive. */
  expectHeader(name: string, expected?: string | RegExp): this {
    const actual = this.header(name);
    if (actual === undefined)
      throw new Error(
        `Expected response header "${name}" but it was not sent. Sent: ${Object.keys(this.headers()).join(', ')}`,
      );
    if (
      expected !== undefined &&
      !(typeof expected === 'string' ? actual === expected : expected.test(actual))
    ) {
      throw new Error(
        `Expected response header "${name}" to be ${String(expected)} but got "${actual}"`,
      );
    }
    return this;
  }

  /** The Content-Type contains the given media type, e.g. `expectContentType('json')`. */
  expectContentType(mediaType: string): this {
    const actual = this.header('content-type') ?? '';
    if (!actual.toLowerCase().includes(mediaType.toLowerCase()))
      throw new Error(`Expected Content-Type to contain "${mediaType}" but got "${actual}"`);
    return this;
  }

  /** The raw body text contains the string (or matches the pattern). */
  expectBodyContains(expected: string | RegExp): this {
    const found =
      typeof expected === 'string' ? this.rawText.includes(expected) : expected.test(this.rawText);
    if (!found)
      throw new Error(
        `Expected the response body to contain ${String(expected)}\nBody: ${this.rawText.slice(0, 1000)}`,
      );
    return this;
  }

  /** The body contains everything in `subset` (extra fields in the response are fine) - see subsetDifferences. */
  expectMatches(subset: unknown): this {
    const differences = subsetDifferences(this.parsedBody, subset);
    if (differences.length > 0)
      throw new Error(
        `Response body does not match the expected subset:\n  ${differences.join('\n  ')}\nBody: ${this.rawText.slice(0, 1000)}`,
      );
    return this;
  }

  /** The array at `path` (or the whole body when omitted) has exactly `count` items. */
  expectArrayLength(path: string | undefined, count: number): this {
    const value = path === undefined ? this.parsedBody : this.get(path);
    if (!Array.isArray(value))
      throw new Error(`Expected ${path ?? 'the body'} to be an array but got ${typeof value}`);
    if (value.length !== count)
      throw new Error(
        `Expected ${path ?? 'the body'} to have ${count} item(s) but it has ${value.length}`,
      );
    return this;
  }

  /** The call took no longer than `maxMs` - a coarse SLA check, not a load test. */
  expectResponseTimeUnder(maxMs: number): this {
    if (this.durationMs > maxMs)
      throw new Error(`Expected a response within ${maxMs}ms but it took ${this.durationMs}ms`);
    return this;
  }

  /** A GraphQL response with no `errors` array (GraphQL answers 200 even when the query failed). */
  expectNoGraphqlErrors(): this {
    const errors = this.get<unknown[] | undefined>('errors');
    if (Array.isArray(errors) && errors.length > 0)
      throw new Error(
        `GraphQL returned ${errors.length} error(s): ${JSON.stringify(errors).slice(0, 1000)}`,
      );
    return this;
  }

  /** The body as stable, pretty JSON text with volatile fields masked - what a stored snapshot compares. */
  snapshotText(maskKeys: Array<string | RegExp> = []): string {
    const body =
      typeof this.parsedBody === 'string'
        ? this.parsedBody
        : JSON.stringify(maskFields(this.parsedBody, maskKeys), sortKeys, 2);
    return `${body}\n`;
  }

  expectSchema(schema: object): this {
    const result = this.validateSchema(schema);
    if (!result.valid) {
      throw new Error(`Response failed schema validation: ${result.errorsText}`);
    }
    return this;
  }
}

export interface ResponseCookie {
  name: string;
  value: string;
  /** Attributes as sent, lower-cased names; flags (HttpOnly, Secure) are `true`. */
  attributes: Record<string, string | true>;
}

function parseSetCookie(header: string): ResponseCookie {
  const [pair = '', ...rest] = header.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const attributes: Record<string, string | true> = {};
  for (const part of rest) {
    const index = part.indexOf('=');
    if (index === -1) attributes[part.toLowerCase()] = true;
    else attributes[part.slice(0, index).toLowerCase()] = part.slice(index + 1);
  }
  return {
    name: separator === -1 ? pair : pair.slice(0, separator),
    value: separator === -1 ? '' : pair.slice(separator + 1),
    attributes,
  };
}

/** JSON.stringify replacer that writes object keys in sorted order, so a snapshot does not change when the server reorders fields. */
function sortKeys(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
}
