import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { remote, testing } from '@automation/referenced-automation-utils';
import { ApiClient } from '../../src/client/apiClient';
import { RemoteRequestContext, type RemoteRequestContextOptions } from '../../src/remote/remoteRequestContext';
import { startTestServer, stopTestServer, type TestServerHandle } from './testServer';

/**
 * "The API on the remote side" for the remote-desktop specs: this repo's in-process test server, reached through a
 * RemoteHost whose agent is `testing.StandInAgent` (a Node implementation of the remote agent over a temp folder).
 * Nothing here needs RDP or Windows; the real PowerShell agent is NOT exercised.
 */
export interface RemoteHarness {
  dir: string;
  agent: InstanceType<typeof testing.StandInAgent>;
  host: remote.RemoteHost;
  server: TestServerHandle;
  /** Every `RemoteHost.http` request the client sent, as the agent received it. */
  sent: remote.RemoteHttpRequest[];
  context(options?: RemoteRequestContextOptions): RemoteRequestContext;
  client(options?: RemoteRequestContextOptions): ApiClient;
  /** How many `http` requests the agent processed since the last `reset()`. */
  agentHttpCalls(): number;
  reset(): void;
  close(): Promise<void>;
}

export async function startRemoteHarness(
  overrides: Partial<remote.RemoteConfigValues> = {},
): Promise<RemoteHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-remote-'));
  const server = await startTestServer();
  const agent = new testing.StandInAgent({ shareDir: dir });
  await agent.start();
  const host = new remote.RemoteHost(testing.standInRemoteConfig(dir, overrides));
  const sent: remote.RemoteHttpRequest[] = [];
  const original = host.http.bind(host);
  host.http = async (request) => {
    sent.push(request);
    return original(request);
  };
  await host.connect();
  const context = (options: RemoteRequestContextOptions = {}) =>
    new RemoteRequestContext(host, { baseURL: server.baseUrl, ...options });
  return {
    dir,
    agent,
    host,
    server,
    sent,
    context,
    client: (options) => new ApiClient(context(options).asApiRequestContext(), server.baseUrl),
    agentHttpCalls: () => agent.processed.filter((type) => type === 'http').length,
    reset: () => {
      agent.processed.length = 0;
      sent.length = 0;
    },
    close: async () => {
      await host.close().catch(() => undefined);
      await agent.stop().catch(() => undefined);
      await stopTestServer(server);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
