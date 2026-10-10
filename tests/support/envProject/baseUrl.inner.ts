import { test, expect } from '../../../src/fixtures/apiFixtures';

test('the apiClient fixture reads API_BASE_URL from the .env.qa next to the Playwright config', async ({
  apiClient,
}) => {
  expect(apiClient.getBaseUrl()).toBe('http://env-project.test/api');
});
