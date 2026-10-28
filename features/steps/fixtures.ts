import { request as playwrightRequest, mergeTests } from '@playwright/test';
import { test as bddTest } from 'playwright-bdd';
import { ApiClient } from '../../src/client/apiClient';
import type { ApiResponse } from '../../src/client/apiResponse';
import { test as apiTest } from '../../src/fixtures/apiFixtures';
import {
  startTestServer,
  stopTestServer,
  type TestServerHandle,
} from '../../tests/support/testServer';

/** A request or a collection that was TRIED because the scenario expects it to fail: what happened, for the "Then" steps. */
export interface Attempt {
  /** True once a "When I try to ..." step has run. */
  ran: boolean;
  error?: Error;
  /** What "I collect every page ..." gathered. */
  items?: unknown[];
}

/** Extra in-process services a scenario can start (a gateway with a path prefix, another host), stopped after the scenario. */
export interface Services {
  /** Starts a service and remembers it under `name`. */
  start(name: string, prefix?: string): Promise<TestServerHandle>;
  /** The service started under `name`; fails clearly when the scenario never started it. */
  get(name: string): TestServerHandle;
}

/**
 * The test the Gherkin steps run in: this package's `test` (apiClient, vars, apiScenario, cleanup, failure evidence ...)
 * with `apiClient` pointed at an in-process server so the sample features run anywhere. In your own project delete the
 * `testServer`/`apiClient` overrides: the steps then call API_BASE_URL from your .env.<ENV> file.
 *
 * The `attempt`, `services` and `parallel` fixtures belong to the steps in this folder that exercise this repo's own test
 * server (gateway, counters, failing identity providers); they start only in scenarios that use those steps.
 */
// playwright-bdd needs its own `test` underneath; mergeTests combines it with the API one.
export const test = mergeTests(bddTest, apiTest).extend<
  { attempt: Attempt; services: Services; parallel: { responses: ApiResponse[] } },
  { testServer: TestServerHandle }
>({
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
  attempt: async ({}, use) => {
    await use({ ran: false });
  },
  parallel: async ({}, use) => {
    await use({ responses: [] });
  },
  services: async ({}, use) => {
    const started = new Map<string, TestServerHandle>();
    await use({
      async start(name, prefix) {
        const server = await startTestServer(prefix ? { prefix } : {});
        started.set(name, server);
        return server;
      },
      get(name) {
        const server = started.get(name);
        if (!server)
          throw new Error(`No "${name}" service is running: start it with a Given step first`);
        return server;
      },
    });
    for (const server of started.values()) await stopTestServer(server);
  },
});
