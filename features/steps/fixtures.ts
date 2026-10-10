import { request as playwrightRequest, mergeTests } from '@playwright/test';
import { test as bddTest } from 'playwright-bdd';
import { ApiClient } from '../../src/client/apiClient';
import { test as apiTest } from '../../src/fixtures/apiFixtures';
import {
  startTestServer,
  stopTestServer,
  type TestServerHandle,
} from '../../tests/support/testServer';

/**
 * The test the Gherkin steps run in: this package's `test` (apiClient, vars, apiScenario, cleanup, failure evidence ...)
 * with `apiClient` pointed at an in-process server so the sample features run anywhere. In your own project delete the
 * `testServer`/`apiClient` overrides: the steps then call API_BASE_URL from your .env.<ENV> file.
 */
// playwright-bdd needs its own `test` underneath; mergeTests combines it with the API one.
export const test = mergeTests(bddTest, apiTest).extend<object, { testServer: TestServerHandle }>({
  testServer: [
    async ({}, use) => {
      const server = await startTestServer();
      await use(server);
      await stopTestServer(server);
    },
    { scope: 'worker' },
  ],
  apiClient: async ({ testServer }, use) => {
    const context = await playwrightRequest.newContext();
    await use(new ApiClient(context, testServer.baseUrl));
    await context.dispose();
  },
});
