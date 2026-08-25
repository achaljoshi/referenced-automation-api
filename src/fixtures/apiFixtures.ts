import { test as base, request as playwrightRequest } from '@playwright/test';
import { loadEnv } from '@automation/referenced-automation-utils';
import { ApiClient } from '../client/apiClient';
import { MockServer } from '../mock/mockServer';

interface ApiFixtures {
  apiClient: ApiClient;
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
  apiClient: async ({}, use) => {
    const env = loadEnv();
    const baseUrl = env.get('API_BASE_URL', '');
    const context = await playwrightRequest.newContext({ baseURL: baseUrl || undefined });
    const client = new ApiClient(context, baseUrl);
    await use(client);
    await context.dispose();
  },

  mockServer: async ({}, use) => {
    const server = new MockServer();
    await server.start();
    await use(server);
    await server.stop();
  },
});

export { expect } from '@playwright/test';
