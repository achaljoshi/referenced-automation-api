import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Socket } from 'node:net';
import { ApiClient } from '../src/client/apiClient';
import {
  BasicAuth,
  OAuth2ClientCredentials,
  OAuth2PasswordAuth,
  SessionCookieAuth,
} from '../src/auth/authProvider';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';

let server: TestServerHandle;
let context: APIRequestContext;
let unique = 0;
const tenant = () => `t${Date.now()}-${unique++}`;

test.beforeAll(async () => {
  server = await startTestServer();
  context = await playwrightRequest.newContext();
});

test.afterAll(async () => {
  await context.dispose();
  await stopTestServer(server);
});

async function calls(key: string): Promise<number> {
  const response = await context.get(`${server.baseUrl}/calls/${key}`);
  return ((await response.json()) as { calls: number }).calls;
}

test.describe('token acquisition is single-flight @regression', () => {
  test('parallel first requests share ONE token request (client credentials)', async () => {
    const id = tenant();
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new OAuth2ClientCredentials({
        tokenUrl: `${server.baseUrl}/oauth/token-counted?tenant=${id}`,
        clientId: 'client',
        clientSecret: 'secret',
      }),
    );
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => client.get('/protected/oauth')),
    );
    expect(responses.map((r) => r.status())).toEqual(Array(8).fill(200));
    expect(await calls(`token:${id}`)).toBe(1);
  });

  test('parallel requests on an expired token do not race a rotating refresh token', async () => {
    const id = tenant();
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new OAuth2PasswordAuth({
        tokenUrl: `${server.baseUrl}/oauth/rotating-token?tenant=${id}`,
        username: 'ada',
        password: 'lovelace',
        refreshSkewSeconds: 0,
      }),
    );
    expect((await client.get('/protected/rotating')).status()).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // the 1 s access token expires
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => client.get('/protected/rotating')),
    );
    expect(responses.map((r) => r.status())).toEqual(Array(6).fill(200));
    // one login, then ONE refresh: without single-flight the other five refreshes fail (the token is single-use) and each logs in again
    expect(await calls(`rot:${id}:password`)).toBe(1);
    expect(await calls(`rot:${id}:refresh`)).toBe(1);
  });

  test('parallel first requests share one login (session cookie)', async () => {
    const id = tenant();
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new SessionCookieAuth({
        loginUrl: `${server.baseUrl}/session/login-counted?tenant=${id}`,
        credentials: { username: 'ada', password: 'lovelace' },
      }),
    );
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => client.get(`/protected/session-counted?tenant=${id}`)),
    );
    expect(responses.map((r) => r.status())).toEqual(Array(5).fill(200));
    expect(await calls(`login:${id}`)).toBe(1);
  });

  test('a token is fetched again after a failure (the failed attempt is not cached)', async () => {
    const wrong = new OAuth2ClientCredentials({
      tokenUrl: `${server.baseUrl}/oauth/token-counted?tenant=${tenant()}`,
      clientId: 'client',
      clientSecret: 'WRONG',
    });
    const client = new ApiClient(context, server.baseUrl).setAuth(wrong);
    await expect(client.get('/protected/oauth')).rejects.toThrow(/token request failed: 401/);
    await expect(client.get('/protected/oauth')).rejects.toThrow(/token request failed: 401/);
  });
});

test.describe('the identity-provider call goes through the client @regression', () => {
  test('it is in the exchange log, with the credentials and the token masked', async () => {
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new OAuth2ClientCredentials({
        tokenUrl: `${server.baseUrl}/oauth/token-counted?tenant=${tenant()}`,
        clientId: 'client',
        clientSecret: 'secret',
      }),
    );
    await client.get('/protected/oauth');
    const [tokenCall, apiCall] = client.exchanges();
    expect(tokenCall?.method).toBe('POST');
    expect(tokenCall?.url).toContain('/oauth/token-counted');
    expect(tokenCall?.status).toBe(200);
    expect(tokenCall?.requestBody).toContain('client_secret=%5BREDACTED%5D');
    expect(tokenCall?.requestBody).not.toContain('=secret');
    expect(tokenCall?.responseBody).not.toContain('issued-token');
    expect(apiCall?.url).toContain('/protected/oauth');
  });

  test('it uses the client connection: the proxy of the context sees the token call', async () => {
    // Playwright tunnels through a proxy with CONNECT. This proxy records where each tunnel was asked to go, then
    // connects every one to the in-process server - so the hosts below never need to exist.
    const tunnels: string[] = [];
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    };
    const proxy = http.createServer();
    proxy.on('connection', track);
    proxy.on('connect', (req, clientSocket: Socket) => {
      tunnels.push(req.url ?? '');
      const upstream = net.connect(new URL(server.origin).port as unknown as number, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      track(upstream);
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as { port: number }).port;
    const proxied = await playwrightRequest.newContext({ proxy: { server: `http://127.0.0.1:${port}` } });
    try {
      const client = new ApiClient(proxied, 'http://api.proxied.invalid').setAuth(
        new OAuth2ClientCredentials({
          tokenUrl: `http://idp.proxied.invalid/oauth/token-counted?tenant=${tenant()}`,
          clientId: 'client',
          clientSecret: 'secret',
        }),
      );
      const response = await client.get('/protected/oauth');
      expect(response.status()).toBe(200);
      // the token request (idp host) and the API request (api host) both went through the proxy
      expect(tunnels).toEqual(['idp.proxied.invalid:80', 'api.proxied.invalid:80']);
    } finally {
      await proxied.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });

  test('a token request has a timeout, inside a client and outside one', async () => {
    const provider = () =>
      new OAuth2ClientCredentials({
        tokenUrl: `${server.baseUrl}/oauth/hang`,
        clientId: 'client',
        clientSecret: 'secret',
        timeoutMs: 300,
      });
    const client = new ApiClient(context, server.baseUrl).setAuth(provider());
    const startedAt = Date.now();
    await expect(client.get('/protected/oauth')).rejects.toThrow(/imeout|timed out/);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(client.exchanges().at(-1)?.error).toBeDefined();

    // used on its own (no ApiClient, so the global fetch fallback)
    await expect(provider().apply({ headers: {}, queryParams: {} })).rejects.toThrow(
      /timed out after 300ms/,
    );
  });

  test('without a client the provider still works (fetch fallback)', async () => {
    const target = { headers: {} as Record<string, string>, queryParams: {} };
    await new OAuth2ClientCredentials({
      tokenUrl: `${server.baseUrl}/oauth/token-counted?tenant=${tenant()}`,
      clientId: 'client',
      clientSecret: 'secret',
    }).apply(target);
    expect(target.headers.Authorization).toBe('Bearer issued-token');
  });
});

test.describe('failures do not echo what the identity provider said @regression', () => {
  test('only the standard error fields are shown, with credentials masked', async () => {
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new OAuth2ClientCredentials({
        tokenUrl: `${server.baseUrl}/oauth/token-error`,
        clientId: 'client',
        clientSecret: 'sup3r-s3cret-value',
      }),
    );
    const error = await client.get('/protected/oauth').catch((e: Error) => e);
    const message = (error as Error).message;
    expect(message).toMatch(/token request failed: 400 \(invalid_client: client secret \[REDACTED\] is not valid\)/);
    expect(message).not.toContain('sup3r-s3cret-value');
    expect(message).not.toContain('debug');
    expect(message).not.toContain('received');
  });

  test('a non-JSON error body (an HTML gateway page) is not repeated at all', async () => {
    const provider = new OAuth2PasswordAuth({
      tokenUrl: `${server.baseUrl}/oauth/token-html`,
      username: 'ada',
      password: 'lovelace-pw-1',
    });
    const error = await provider.apply({ headers: {}, queryParams: {} }).catch((e: Error) => e);
    expect((error as Error).message).toBe('OAuth2 password grant failed: 502');
  });

  test('a failed login does not repeat the credentials it was sent', async () => {
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new SessionCookieAuth({
        loginUrl: `${server.baseUrl}/session/login-counted?tenant=${tenant()}`,
        credentials: { username: 'ada', password: 'wrong-pw-xyz' },
      }),
    );
    const error = await client.get('/protected/session-counted').catch((e: Error) => e);
    expect((error as Error).message).toBe('Session login failed: 401 (bad login)');
    expect((error as Error).message).not.toContain('wrong-pw-xyz');
  });

  test('a token response with no access_token is an error, not a cached "undefined"', async () => {
    const provider = new OAuth2ClientCredentials({
      tokenUrl: `${server.baseUrl}/graphql-no-shape`, // answers 200 {"ok":true}
      clientId: 'client',
      clientSecret: 'secret',
    });
    await expect(provider.apply({ headers: {}, queryParams: {} })).rejects.toThrow(/without an access_token/);
  });
});

test.describe('a session that expired logs in again, once @regression', () => {
  test('401 -> new login -> the same request succeeds', async () => {
    const id = tenant();
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new SessionCookieAuth({
        loginUrl: `${server.baseUrl}/session/login-counted?tenant=${id}`,
        credentials: { username: 'ada', password: 'lovelace' },
      }),
    );
    expect((await client.get(`/protected/session-counted?tenant=${id}`)).get('sid')).toBe('s1');
    await context.get(`${server.baseUrl}/session/expire?tenant=${id}`);
    const again = await client.get(`/protected/session-counted?tenant=${id}`);
    expect(again.status()).toBe(200);
    expect(again.get('sid')).toBe('s2');
    expect(await calls(`login:${id}`)).toBe(2);
  });

  test('a request that is still 401 after the new login is returned as the 401 (no loop)', async () => {
    const id = tenant();
    const client = new ApiClient(context, server.baseUrl).setAuth(
      new SessionCookieAuth({
        loginUrl: `${server.baseUrl}/session/login-counted?tenant=${id}`,
        credentials: { username: 'ada', password: 'lovelace' },
      }),
    );
    const response = await client.get('/protected/basic'); // never accepts a cookie
    expect(response.status()).toBe(401);
    expect(await calls(`login:${id}`)).toBe(2); // the first login and exactly one more
  });

  test('providers without reauthenticate (Basic) are not retried on 401', async () => {
    const client = new ApiClient(context, server.baseUrl).setAuth(new BasicAuth('user', 'WRONG'));
    expect((await client.get('/protected/basic')).status()).toBe(401);
    expect(client.exchanges()).toHaveLength(1);
  });
});
