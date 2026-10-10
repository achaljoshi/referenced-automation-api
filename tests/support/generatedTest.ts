import { request as playwrightRequest } from '@playwright/test';
import { ApiClient } from '../../src/client/apiClient';
import { test as apiTest, expect } from '../../src/fixtures/apiFixtures';
import { startTestServer, stopTestServer, type TestServerHandle } from './testServer';

// The made-up credentials the in-process test server accepts. Real projects set these from .env.<ENV>.local or CI variables.
process.env.API_TOKEN ??= 'expected-token';
process.env.API_KEY ??= 'expected-key';
process.env.API_USER ??= 'user';
process.env.API_PASSWORD ??= 'pass';

/**
 * The base test for the tests generated from curl/examples.curl: the framework's own `test`, with `apiClient`
 * pointed at an in-process server instead of API_BASE_URL, so the generated tests run offline. In a real project
 * you do not need this file - the generated tests use `apiClient` as configured by your .env.<ENV> file.
 */
export const test = apiTest.extend<object, { testServer: TestServerHandle }>({
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

export { expect };
