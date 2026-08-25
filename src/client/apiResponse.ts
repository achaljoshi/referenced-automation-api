import type { APIResponse } from '@playwright/test';
import {
  getPath,
  hasPath,
  requirePath,
  validateSchema,
  type SchemaValidationResult,
} from '@automation/referenced-automation-utils';
import { fromXml } from './xml';

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

  private constructor(raw: APIResponse, parsedBody: unknown, rawText: string) {
    this.raw = raw;
    this.parsedBody = parsedBody;
    this.rawText = rawText;
  }

  static async from(raw: APIResponse): Promise<ApiResponse> {
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

    return new ApiResponse(raw, parsedBody, rawText);
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
      throw new Error(`Expected "${path}" to be ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
    }
    return this;
  }

  expectSchema(schema: object): this {
    const result = this.validateSchema(schema);
    if (!result.valid) {
      throw new Error(`Response failed schema validation: ${result.errorsText}`);
    }
    return this;
  }
}
