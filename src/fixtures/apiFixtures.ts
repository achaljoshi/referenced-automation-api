import { test as base, request as playwrightRequest } from '@playwright/test';
import { loadEnv } from '@automation/referenced-automation-utils';
import { ApiClient } from '../client/apiClient';

/**
 * Drop-in Playwright Test fixture: `import { test, expect } from
 * '@automation/referenced-automation-api'` gives every test a ready-to-use
 * `apiClient` pointed at API_BASE_URL from the active .env.<ENV> file - no
 * per-test setup/teardown of an APIRequestContext required.
 */
export const test = base.extend<{ apiClient: ApiClient }>({
  apiClient: async ({}, use) => {
    const env = loadEnv();
    const baseUrl = env.get('API_BASE_URL', '');
    const context = await playwrightRequest.newContext({ baseURL: baseUrl || undefined });
    const client = new ApiClient(context, baseUrl);
    await use(client);
    await context.dispose();
  },
});

export { expect } from '@playwright/test';
