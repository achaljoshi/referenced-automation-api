import {
  test as base,
  type TestInfo,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';
import {
  loadEnv,
  placeholders,
  remote,
  useTestCorrelation,
  type ConfigReader,
} from '@automation/referenced-automation-utils';
import { ApiClient } from '../client/apiClient';
import type { AuthProvider } from '../auth/authProvider';
import { formatExchanges } from '../client/exchange';
import { MockServer } from '../mock/mockServer';
import { CleanupRegistry } from './cleanup';
import { ApiScenario } from '../bdd/scenario';
import { projectDir } from '../util/projectDir';
import { markTestStart } from '../util/poll';
import { RemoteRequestContext, type RemoteRequestContextOptions } from '../remote/remoteRequestContext';

/** What `apiFor` needs to make a client for another user / system / environment. */
export interface ApiForOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: AuthProvider;
  /** A saved login (path to a storageState file, or its contents) so the client starts with that session's cookies. */
  storageState?: string;
  ignoreHTTPSErrors?: boolean;
}

/** Worker-scoped: what is shared by every test of one worker process. */
export interface ApiWorkerFixtures {
  /** The remote desktop host of this worker (connected once, closed at worker teardown), or `undefined` when REMOTE_ENABLED is not true. Asking for it connects. */
  remoteHost: remote.RemoteHost | undefined;
  /** Internal: connects to the remote host only when called, so a run that never uses it never opens an RDP session. */
  remoteHostLazy: () => Promise<remote.RemoteHost | undefined>;
}

export interface ApiFixtures {
  /** This test's correlation ID - automatic (every test gets one), sent as X-Correlation-Id on every ApiClient call and shown on every log line. Request it only if you need the value itself. */
  correlationId: string;
  /** Calls made from the test machine - or, with `API_VIA_REMOTE=true`, from the remote desktop host (see `remoteApiClient`). */
  apiClient: ApiClient;
  /** An ApiClient whose every call is made FROM the remote desktop host (REMOTE_ENABLED=true). Base URL: REMOTE_API_BASE_URL, else API_BASE_URL - as seen from the host. */
  remoteApiClient: ApiClient;
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

/** True when `API_VIA_REMOTE=true`: `apiClient` / `apiFor` then call from the remote host. */
function viaRemote(env: ConfigReader): boolean {
  return env.getBoolean('API_VIA_REMOTE', false);
}

/** The base URL as the remote host sees it: REMOTE_API_BASE_URL, else API_BASE_URL. */
function remoteBaseUrl(env: ConfigReader, fallback?: string): string {
  return env.get('REMOTE_API_BASE_URL', '') || fallback || env.get('API_BASE_URL', '');
}

function requireHost(host: remote.RemoteHost | undefined, why: string): remote.RemoteHost {
  if (host) return host;
  throw new Error(
    `${why} needs the remote desktop host, but REMOTE_ENABLED is not true. Set the REMOTE_* keys (REMOTE_ENABLED=true, REMOTE_RDP_HOST, REMOTE_RDP_USER, REMOTE_RDP_PASSWORD in .env.<env>.local ...; see .env.example and the utils docs/REMOTE_DESKTOP.md), or unset API_VIA_REMOTE.`,
  );
}

function remoteContextOptions(testInfo: TestInfo, baseURL: string, overrides: Partial<RemoteRequestContextOptions> = {}): RemoteRequestContextOptions {
  const use = testInfo.project.use;
  return {
    baseURL,
    extraHTTPHeaders: use.extraHTTPHeaders,
    ignoreHTTPSErrors: use.ignoreHTTPSErrors,
    ...overrides,
  };
}

export const test = base.extend<ApiFixtures, ApiWorkerFixtures>({
  remoteHostLazy: [
    async ({}, use, workerInfo) => {
      let connecting: Promise<remote.RemoteHost | undefined> | undefined;
      await use(() => (connecting ??= remote.getRemoteHost(loadEnv({ dir: projectDir(workerInfo) }))));
      // Closes the worker's host, if anything asked for it; "the last worker out" rule is the host's own.
      if (connecting) await remote.closeRemoteHost();
    },
    { scope: 'worker' },
  ],

  remoteHost: [
    async ({ remoteHostLazy }, use) => {
      await use(await remoteHostLazy());
    },
    { scope: 'worker' },
  ],

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
  apiClient: async ({ request, baseURL, remoteHostLazy }, use, testInfo) => {
    const env = loadEnv({ dir: projectDir(testInfo) });
    if (viaRemote(env)) {
      const host = requireHost(await remoteHostLazy(), 'API_VIA_REMOTE=true');
      const context = new RemoteRequestContext(host, remoteContextOptions(testInfo, remoteBaseUrl(env, baseURL)));
      await use(new ApiClient(context.asApiRequestContext(), remoteBaseUrl(env, baseURL)));
      return;
    }
    await use(new ApiClient(request, baseURL || env.get('API_BASE_URL', '')));
  },

  remoteApiClient: async ({ baseURL, remoteHostLazy }, use, testInfo) => {
    const env = loadEnv({ dir: projectDir(testInfo) });
    const host = requireHost(await remoteHostLazy(), 'remoteApiClient');
    const url = remoteBaseUrl(env, baseURL);
    const context = new RemoteRequestContext(host, remoteContextOptions(testInfo, url));
    await use(new ApiClient(context.asApiRequestContext(), url));
  },

  apiFor: async ({ apiClient, remoteHostLazy }, use, testInfo) => {
    const contexts: APIRequestContext[] = [];
    const env = loadEnv({ dir: projectDir(testInfo) });
    await use(async (options = {}) => {
      if (viaRemote(env)) {
        // Same switch as apiClient: another user's client calls from the remote host too (a saved storageState cannot).
        const host = requireHost(await remoteHostLazy(), 'API_VIA_REMOTE=true');
        const remoteContext = new RemoteRequestContext(
          host,
          remoteContextOptions(testInfo, options.baseUrl ?? apiClient.getBaseUrl(), {
            ...(options.ignoreHTTPSErrors !== undefined ? { ignoreHTTPSErrors: options.ignoreHTTPSErrors } : {}),
            storageState: options.storageState,
          }),
        );
        return apiClient
          .scoped({
            baseUrl: options.baseUrl ?? apiClient.getBaseUrl(),
            headers: options.headers,
            auth: options.auth ?? null,
            dropCredentialHeaders: true,
          })
          .withContext(remoteContext.asApiRequestContext());
      }
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
