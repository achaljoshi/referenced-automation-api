import { test, expect } from '../../../src/fixtures/apiFixtures';

// REMOTE_ENABLED is not set: the remote fixtures must say what to configure, and (without API_VIA_REMOTE) the normal apiClient must not change.
test('remoteApiClient needs REMOTE_ENABLED', async ({ remoteApiClient }) => {
  expect(remoteApiClient).toBeDefined();
});

test('apiClient', async ({ apiClient }) => {
  expect(apiClient.getBaseUrl()).toBe('http://local-side.test');
});
