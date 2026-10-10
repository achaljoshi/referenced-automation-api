import { isDeepStrictEqual } from 'node:util';
import { expect as baseExpect } from '@playwright/test';
import type { ApiResponse } from '../client/apiResponse';
import { subsetDifferences } from '../client/subset';

type Result = { pass: boolean; message: () => string };

const body = (response: ApiResponse) => response.text().slice(0, 500);

/**
 * Playwright's `expect` plus matchers for an ApiResponse, so API specs read like the UI ones and failures say what
 * the service answered:
 *
 *   await expect(response).toHaveStatus(201);
 *   await expect(response).toBeSuccessful();
 *   await expect(response).toHaveJsonPath('data[0].name', 'Ada');
 *   await expect(response).toMatchJsonSubset({ name: 'Ada', roles: ['admin'] });
 *   await expect(response).toHaveResponseHeader('content-type', /json/);
 *   await expect(response).toRespondWithin(500);
 *
 * (Playwright's own `expect(response).toBeOK()` is for a raw APIResponse; these are for the wrapper.)
 */
export const expect = baseExpect.extend({
  async toHaveStatus(response: ApiResponse, expected: number | number[]): Promise<Result> {
    const accepted = Array.isArray(expected) ? expected : [expected];
    const pass = accepted.includes(response.status());
    return {
      pass,
      message: () =>
        pass
          ? `Expected status not to be ${accepted.join(' or ')}`
          : `Expected status ${accepted.join(' or ')} but got ${response.status()} ${response.statusText()}\nBody: ${body(response)}`,
    };
  },

  async toBeSuccessful(response: ApiResponse): Promise<Result> {
    const pass = response.status() >= 200 && response.status() < 300;
    return {
      pass,
      message: () =>
        pass
          ? `Expected a non-2xx response but got ${response.status()}`
          : `Expected a 2xx response but got ${response.status()} ${response.statusText()}\nBody: ${body(response)}`,
    };
  },

  async toHaveJsonPath(response: ApiResponse, path: string, expected?: unknown): Promise<Result> {
    const present = response.has(path);
    if (arguments.length < 3) {
      return {
        pass: present,
        message: () =>
          present
            ? `Expected "${path}" to be absent`
            : `Expected "${path}" to be present\nBody: ${body(response)}`,
      };
    }
    const actual = response.get(path);
    const pass = present && isDeepStrictEqual(actual, expected);
    return {
      pass,
      message: () =>
        pass
          ? `Expected "${path}" not to equal ${JSON.stringify(expected)}`
          : `Expected "${path}" to equal ${JSON.stringify(expected)} but got ${present ? JSON.stringify(actual) : '(absent)'}\nBody: ${body(response)}`,
    };
  },

  async toMatchJsonSubset(response: ApiResponse, subset: unknown): Promise<Result> {
    const differences = subsetDifferences(response.body(), subset);
    const pass = differences.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? 'Expected the body not to contain that subset'
          : `Body does not match the expected subset:\n  ${differences.join('\n  ')}\nBody: ${body(response)}`,
    };
  },

  async toMatchJsonSchema(response: ApiResponse, schema: object): Promise<Result> {
    const result = response.validateSchema(schema);
    return {
      pass: result.valid,
      message: () =>
        result.valid
          ? 'Expected the body not to satisfy the schema'
          : `Body failed schema validation: ${result.errorsText}\nBody: ${body(response)}`,
    };
  },

  async toHaveResponseHeader(
    response: ApiResponse,
    name: string,
    expected?: string | RegExp,
  ): Promise<Result> {
    const actual = response.header(name);
    const pass =
      actual !== undefined &&
      (expected === undefined ||
        (typeof expected === 'string' ? actual === expected : expected.test(actual)));
    return {
      pass,
      message: () =>
        pass
          ? `Expected header "${name}" not to be ${String(expected ?? 'present')}`
          : actual === undefined
            ? `Expected header "${name}" but it was not sent. Sent: ${Object.keys(response.headers()).join(', ')}`
            : `Expected header "${name}" to be ${String(expected)} but got "${actual}"`,
    };
  },

  async toRespondWithin(response: ApiResponse, maxMs: number): Promise<Result> {
    const pass = response.durationMs <= maxMs;
    return {
      pass,
      message: () =>
        pass
          ? `Expected the response to take longer than ${maxMs}ms`
          : `Expected a response within ${maxMs}ms but it took ${response.durationMs}ms`,
    };
  },
});
