import {
  test as base,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';
import { loadEnv, placeholders, useTestCorrelation } from '@automation/referenced-automation-utils';
import { ApiClient } from '../client/apiClient';
import type { AuthProvider } from '../auth/authProvider';
import { formatExchanges } from '../client/exchange';
import { MockServer } from '../mock/mockServer';
import { CleanupRegistry } from './cleanup';
import { ApiScenario } from '../bdd/scenario';
import { projectDir } from '../util/projectDir';
import { markTestStart } from '../util/poll';

/** What `apiFor` needs to make a client for another user / system / environment. */
export interface ApiForOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: AuthProvider;
  /** A saved login (path to a storageState file, or its contents) so the client starts with that session's cookies. */
  storageState?: string;
  ignoreHTTPSErrors?: boolean;
}

export interface ApiFixtures {
  /** This test's correlation ID - automatic (every test gets one), sent as X-Correlation-Id on every ApiClient call and shown on every log line. Request it only if you need the value itself. */
  correlationId: string;
  apiClient: ApiClient;
  /** Makes another client for a different user, key or environment: `const admin = await apiFor({ auth: new BearerAuth(token) })`. Every client it makes is disposed after the test. */
  apiFor: (options?: ApiForOptions) => Promise<ApiClient>;
  /** Undo what the test created, newest first, even when it failed. See CleanupRegistry. */
  cleanup: CleanupRegistry;
  /** This test's named values and `{{placeholders}}` ({{uuid}}, {{random:email}}, {{date:+7d}}, {{env:X}}, {{name}}) - used by the Gherkin steps, handy in any test: `vars.interpolate('user-{{uuid}}')`. */
  vars: placeholders.ScenarioVariables;
  /** What a Gherkin scenario carries between steps (pending query parameters, the last response). */
  apiScenario: ApiScenario;
  /** Automatic: when a test fails, the calls its `apiClient` made (credentials masked) are attached to the report as `api-exchanges.txt`. */
  attachExchangesOnFailure: void;
  /** A fresh MockServer, started before the test and stopped after - only paid for by tests that ask for it. */
  mockServer: MockServer;
}

/**
 * Drop-in Playwright Test fixture: `import { test, expect } from
 * '@automation/referenced-automation-api'` gives every test a ready-to-use
 * `apiClient` pointed at API_BASE_URL from the active .env.<ENV> file - no
 * per-test setup/teardown of an APIRequestContext required.
 */
export const test = base.extend<ApiFixtures>({
  correlationId: [
    async ({}, use, testInfo) => {
      markTestStart(testInfo);
      await useTestCorrelation(testInfo, use);
    },
    { auto: true },
  ],

  // Built on Playwright's own `request` fixture, so the project's `use` options (ignoreHTTPSErrors, proxy,
  // extraHTTPHeaders, httpCredentials, clientCertificates, timeouts) apply and the calls show in the trace.
  // The base URL is the project's `baseURL`, else API_BASE_URL from the .env.<ENV> files NEXT TO the Playwright config
  // (not the working directory, which differs between an IDE run and CI).
  apiClient: async ({ request, baseURL }, use, testInfo) => {
    const env = loadEnv({ dir: projectDir(testInfo) });
    await use(new ApiClient(request, baseURL || env.get('API_BASE_URL', '')));
  },

  apiFor: async ({ apiClient }, use) => {
    const contexts: APIRequestContext[] = [];
    await use(async (options = {}) => {
      // Only what the caller set: a key passed as `undefined` would hide the project's own `use` value (e.g. ignoreHTTPSErrors).
      const contextOptions: Parameters<typeof playwrightRequest.newContext>[0] = {};
      if (options.baseUrl) contextOptions.baseURL = options.baseUrl;
      if (options.storageState !== undefined) contextOptions.storageState = options.storageState;
      if (options.ignoreHTTPSErrors !== undefined)
        contextOptions.ignoreHTTPSErrors = options.ignoreHTTPSErrors;
      const context = await playwrightRequest.newContext(contextOptions);
      contexts.push(context);
      // Shares apiClient's exchange log, so a failed test's attachment shows every user's calls.
      // Another user must not carry this client's credentials: only neutral default headers are copied.
      return apiClient
        .scoped({
          baseUrl: options.baseUrl ?? apiClient.getBaseUrl(),
          headers: options.headers,
          auth: options.auth ?? null,
          dropCredentialHeaders: true,
        })
        .withContext(context);
    });
    for (const context of contexts) await context.dispose();
  },

  vars: async ({}, use) => {
    await use(new placeholders.ScenarioVariables());
  },

  apiScenario: async ({}, use) => {
    await use(new ApiScenario());
  },

  cleanup: async ({}, use) => {
    const registry = new CleanupRegistry();
    await use(registry);
    await registry.run();
  },

  attachExchangesOnFailure: [
    async ({ apiClient }, use, testInfo) => {
      await use();
      if (testInfo.status !== testInfo.expectedStatus && apiClient.exchanges().length > 0) {
        await testInfo.attach('api-exchanges.txt', {
          body: formatExchanges([...apiClient.exchanges()]),
          contentType: 'text/plain',
        });
      }
    },
    { auto: true },
  ],

  mockServer: async ({}, use) => {
    const server = new MockServer();
    await server.start();
    await use(server);
    await server.stop();
  },
});

export { expect } from './apiMatchers';
