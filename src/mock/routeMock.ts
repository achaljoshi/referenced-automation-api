import type { Page, Request as PlaywrightRequest } from '@playwright/test';
import { logger } from '@automation/referenced-automation-utils';
import type { HttpMethod } from '../client/types';

export type RouteMockBodyFn = (request: PlaywrightRequest) => unknown | Promise<unknown>;

export interface RouteMockDefinition {
  /** Glob or regex, same syntax/semantics as page.route()'s own first argument. */
  url: string | RegExp;
  /** Restrict the mock to one HTTP method - a non-matching method on the same URL falls through untouched (route.fallback()). */
  method?: HttpMethod;
  /** Static body, or a function computing it from the intercepted Playwright Request (query/postData/headers). */
  // Not `unknown | fn`: a union with `unknown` collapses to `unknown`, and then
  // `(request) => ...` has nothing to infer `request` from (implicit any under strict).
  body?: RouteMockBodyFn | object | string | number | boolean | null;
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  /** Artificial latency before fulfilling - for testing loading spinners/timeouts. */
  delayMs?: number;
}

/**
 * Runtime API mocking for UI tests, on top of Playwright's own `page.route()`
 * - import this in a UI project (`@automation/referenced-automation-api`) to
 * mock the API calls a page makes without a real backend:
 *
 * ```ts
 * import { mockApiRoute } from '@automation/referenced-automation-api';
 *
 * await mockApiRoute(page, {
 *   url: '**\/api/users/*',
 *   method: 'GET',
 *   body: (request) => ({ id: Number(request.url().split('/').pop()), name: 'Ada' }),
 * });
 * await page.goto('/users/42');
 * ```
 */
export async function mockApiRoute(page: Page, definition: RouteMockDefinition): Promise<void> {
  await page.route(definition.url, async (route, request) => {
    if (definition.method && request.method().toUpperCase() !== definition.method) {
      await route.fallback();
      return;
    }

    if (definition.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, definition.delayMs));
    }

    const resolvedBody =
      typeof definition.body === 'function'
        ? await (definition.body as (request: PlaywrightRequest) => unknown)(request)
        : definition.body;

    const isRaw = typeof resolvedBody === 'string' || Buffer.isBuffer(resolvedBody);
    const status = definition.status ?? 200;
    logger.info(`[mockApiRoute] ${request.method()} ${request.url()} -> ${status}`);

    await route.fulfill({
      status,
      contentType: definition.contentType ?? (isRaw ? 'text/plain' : 'application/json'),
      headers: definition.headers,
      body: isRaw ? (resolvedBody as string | Buffer) : JSON.stringify(resolvedBody ?? null),
    });
  });
}

/** Registers several route mocks at once - order matters the same way repeated page.route() calls do (last registered is tried first). */
export async function mockApiRoutes(page: Page, definitions: RouteMockDefinition[]): Promise<void> {
  for (const definition of definitions) {
    await mockApiRoute(page, definition);
  }
}

/** Removes a mock previously registered with the same url pattern, restoring real network behaviour for it. */
export async function unmockApiRoute(page: Page, url: string | RegExp): Promise<void> {
  await page.unroute(url);
}
