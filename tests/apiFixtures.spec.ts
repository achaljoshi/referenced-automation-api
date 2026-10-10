import { test as base, expect } from '../src/fixtures/apiFixtures';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';
import { runPlaywright } from './support/runPlaywright';

// The `apiClient` / `apiFor` fixtures must honour the Playwright project they run in.

/** A throwaway self-signed certificate made at run time (nothing secret is committed); undefined when openssl is not there. */
function selfSigned(dir: string): { key: string; cert: string } | undefined {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const made = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'],
    { encoding: 'utf8' },
  );
  if (made.status !== 0) return undefined;
  return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
}

base.describe('the apiClient fixture reads the project\'s .env from the config folder @regression', () => {
  base('API_BASE_URL comes from the .env.qa next to the Playwright config, whatever the working directory is', () => {
    const configDir = path.join(__dirname, 'support', 'envProject');
    const run = runPlaywright(path.join(configDir, 'playwright.config.ts'), {
      cwd: os.tmpdir(), // not the project: the old `loadEnv()` read .env files from here and found none
      env: { API_BASE_URL: undefined, ENV: undefined, ENVIRONMENT: undefined },
    });
    expect({ passed: run.passed, failed: run.failed }, run.summary).toEqual({
      passed: 1,
      failed: 0,
    });
  });
});

base.describe('project `use` options reach the server @regression', () => {
  let server: TestServerHandle;

  base.beforeAll(async () => {
    server = await startTestServer();
  });
  base.afterAll(async () => {
    await stopTestServer(server);
  });

  base.describe('extraHTTPHeaders', () => {
    base.use({ extraHTTPHeaders: { 'x-from-project': 'yes' } });
    base('the apiClient sends them', async ({ apiClient }) => {
      apiClient.setBaseUrl(server.baseUrl);
      const response = await apiClient.get('/headers-echo');
      expect(response.get('headers.x-from-project')).toBe('yes');
    });
    base('a client made by apiFor sends them too', async ({ apiClient, apiFor }) => {
      apiClient.setBaseUrl(server.baseUrl);
      const other = await apiFor();
      const response = await other.get('/headers-echo');
      expect(response.get('headers.x-from-project')).toBe('yes');
    });
  });

  base.describe('ignoreHTTPSErrors', () => {
    base.use({ ignoreHTTPSErrors: true });

    base('apiFor keeps the project setting (it passed `undefined` and dropped it)', async ({ apiFor }, testInfo) => {
      fs.mkdirSync(testInfo.outputDir, { recursive: true });
      const pems = selfSigned(testInfo.outputDir);
      base.skip(pems === undefined, 'openssl is not available to make a test certificate');
      const secure = https.createServer(pems as { key: string; cert: string }, (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"secure":true}');
      });
      await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
      const url = `https://127.0.0.1:${(secure.address() as net.AddressInfo).port}`;
      try {
        const other = await apiFor({ baseUrl: url });
        expect((await other.get('/')).get('secure')).toBe(true);
      } finally {
        secure.closeAllConnections();
        await new Promise((resolve) => secure.close(resolve));
      }
    });
  });
});

// The project's proxy: a worker-scoped CONNECT proxy that records where each tunnel was asked to go and connects it to
// an in-process server, with the project's `proxy` option pointing at it - so the hosts used below never need to exist.
const proxied = base.extend<object, { tunnelProxy: { url: string; tunnels: string[] } }>({
  tunnelProxy: [
    async ({}, use) => {
      const target = await startTestServer();
      const tunnels: string[] = [];
      const sockets = new Set<net.Socket>();
      const track = (socket: net.Socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      };
      const proxy = http.createServer();
      proxy.on('connection', track);
      proxy.on('connect', (req, clientSocket: net.Socket) => {
        tunnels.push(req.url ?? '');
        const upstream = net.connect(Number(new URL(target.origin).port), '127.0.0.1', () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        track(upstream);
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      await use({ url: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, tunnels });
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
      await stopTestServer(target);
    },
    { scope: 'worker' },
  ],
  proxy: async ({ tunnelProxy }, use) => {
    await use({ server: tunnelProxy.url });
  },
});

proxied.describe('the project proxy @regression', () => {
  proxied('the apiClient and apiFor clients go through it', async ({ apiClient, apiFor, tunnelProxy }) => {
    apiClient.setBaseUrl('http://api.proxied.invalid');
    expect((await apiClient.get('/users/1')).status()).toBe(200);
    const other = await apiFor({ baseUrl: 'http://other.proxied.invalid' });
    expect((await other.get('/users/2')).status()).toBe(200);
    expect(tunnelProxy.tunnels).toEqual(
      expect.arrayContaining(['api.proxied.invalid:80', 'other.proxied.invalid:80']),
    );
  });
});

base.describe('apiFor makes a client for ANOTHER user @regression', () => {
  let server: TestServerHandle;
  base.beforeAll(async () => {
    server = await startTestServer();
  });
  base.afterAll(async () => {
    await stopTestServer(server);
  });

  base('it does not inherit the Authorization header of the main client, only neutral headers', async ({ apiClient, apiFor }) => {
    apiClient
      .setBaseUrl(server.baseUrl)
      .setHeader('Authorization', 'Bearer admin-token')
      .setHeader('Cookie', 'sid=admin-session')
      .setHeader('X-Api-Key', 'admin-key')
      .setHeader('X-Tenant', 'acme');
    const guest = await apiFor();
    const echoed = await guest.get('/headers-echo');
    expect(echoed.get('headers.authorization')).toBeUndefined();
    expect(echoed.get('headers.cookie')).toBeUndefined();
    expect(echoed.get('headers.x-api-key')).toBeUndefined();
    expect(echoed.get('headers.x-tenant')).toBe('acme');
    // and the main client is untouched
    expect((await apiClient.get('/headers-echo')).get('headers.authorization')).toBe('Bearer admin-token');
  });
});
