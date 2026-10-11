import * as fs from 'node:fs';
import { testing } from '@automation/referenced-automation-utils';
import { test, expect } from '../../../src/fixtures/apiFixtures';
import { startTestServer, stopTestServer, type TestServerHandle } from '../testServer';
import { BearerAuth } from '../../../src/auth/authProvider';

// Runs in its own Playwright process with REMOTE_* in the environment. The stand-in agent and the "API on the remote
// side" live in this worker, so the outer test (which blocks while this runs) is not needed for them to answer.
const shareDir = process.env.REMOTE_SHARE_DIR as string;
let server: TestServerHandle;
let agent: InstanceType<typeof testing.StandInAgent>;

test.beforeAll(async () => {
  server = await startTestServer();
  agent = new testing.StandInAgent({ shareDir });
  await agent.start();
});
test.afterAll(async () => {
  await stopTestServer(server);
  await agent.stop();
  fs.rmSync(shareDir, { recursive: true, force: true });
});
test.beforeEach(() => {
  agent.processed.length = 0;
});

const viaRemote = process.env.API_VIA_REMOTE === 'true';
const httpCalls = () => agent.processed.filter((type) => type === 'http').length;

test('with API_VIA_REMOTE=true the apiClient fixture calls from the remote host, no code change', async ({ apiClient }) => {
  test.skip(!viaRemote, 'API_VIA_REMOTE is not true in this run');
  apiClient.setBaseUrl(server.baseUrl);
  const response = await apiClient.get('/users/1');
  expect(response.get('name')).toBe('Ada Lovelace');
  expect(httpCalls()).toBe(1);
  expect(agent.correlationIds.at(-1)).toBeTruthy();
});

test('apiFor clients (another user) call from the remote host too, without the first client\'s credentials', async ({ apiClient, apiFor }) => {
  test.skip(!viaRemote, 'API_VIA_REMOTE is not true in this run');
  apiClient.setBaseUrl(server.baseUrl).setAuth(new BearerAuth('expected-token'));
  const other = await apiFor({ baseUrl: server.baseUrl, auth: new BearerAuth('other-token') });
  expect((await other.get('/protected/bearer')).status()).toBe(401);
  expect((await apiClient.get('/protected/bearer')).status()).toBe(200);
  expect(httpCalls()).toBe(2);
});

test('apiFor with a saved storageState says to run that call from the test machine', async ({ apiFor }) => {
  test.skip(!viaRemote, 'API_VIA_REMOTE is not true in this run');
  await expect(apiFor({ baseUrl: server.baseUrl, storageState: '{}' })).rejects.toThrow(/storageState.*test machine/s);
});

test('remoteApiClient: base URL is REMOTE_API_BASE_URL, else API_BASE_URL', async ({ remoteApiClient }) => {
  expect(remoteApiClient.getBaseUrl()).toBe(process.env.EXPECT_BASE);
  remoteApiClient.setBaseUrl(server.baseUrl);
  expect((await remoteApiClient.get('/users/2')).get('name')).toBe('Grace Hopper');
  expect(httpCalls()).toBe(1);
});

test('the remoteHost fixture is the connected RemoteHost', async ({ remoteHost }) => {
  expect(remoteHost).toBeDefined();
  expect((await remoteHost?.ping())?.agentVersion).toBeTruthy();
});
