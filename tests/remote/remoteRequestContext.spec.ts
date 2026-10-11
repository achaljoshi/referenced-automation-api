import { test, expect } from '@playwright/test';
import { remote } from '@automation/referenced-automation-utils';
import { ApiKeyAuth, BearerAuth, OAuth2ClientCredentials } from '../../src/auth/authProvider';
import { paginateByCursor, paginateByPageNumber } from '../../src/pagination/paginate';
import { RemoteApiResponse, RemoteRequestContext, RemoteRequestError } from '../../src/remote/remoteRequestContext';
import type { ApiClient } from '../../src/client/apiClient';
import { REDACTED, type Exchange } from '../../src/client/exchange';
import { startRemoteHarness, type RemoteHarness } from '../support/remoteHarness';

// Every call below is sent through RemoteHost.http -> the stand-in agent -> this repo's test server, the way a call
// from the RDP host would be. Each test also checks that the agent really saw the request (agentHttpCalls).

let harness: RemoteHarness;
let unique = 0;
const sent = (index: number) => harness.sent.at(index) as remote.RemoteHttpRequest;
const exchange = (client: ApiClient, index: number) => client.exchanges().at(index) as Exchange;
const key = () => `remote-${Date.now()}-${unique++}`;

test.beforeAll(async () => {
  harness = await startRemoteHarness();
});
test.afterAll(async () => {
  await harness.close();
});
test.beforeEach(() => harness.reset());

test.describe('requests and responses through the remote host @regression', () => {
  test('GET JSON: the body is parsed and the call went through the agent', async () => {
    const response = await harness.client().get('/users');
    expect(response.status()).toBe(200);
    expect(response.get('data[0].name')).toBe('Ada Lovelace');
    expect(response.header('content-type')).toContain('json');
    expect(harness.agentHttpCalls()).toBe(1);
    expect(harness.server.requests.at(-1)?.url).toBe('/users');
  });

  test('POST JSON, PUT and DELETE keep their method, body and status', async () => {
    const client = harness.client();
    const created = await client.post('/users', { json: { name: 'Remote Ron', roles: ['a', 'b'] } });
    expect(created.status()).toBe(201);
    expect(created.body()).toEqual({ id: 999, name: 'Remote Ron', roles: ['a', 'b'] });
    const put = await client.put('/users/{id}', { pathParams: { id: 7 }, json: { name: 'Seven' } });
    expect(put.body()).toEqual({ id: 7, name: 'Seven' });
    expect((await client.delete('/users/1')).status()).toBe(204);
    expect(harness.sent.map((r) => r.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });

  test('headers, query parameters, path parameters and a form body arrive as sent', async () => {
    const client = harness.client();
    const search = await client.get('/search', { queryParams: { a: '1', tags: ['x', 'y'] } });
    expect(search.get('query')).toEqual({ a: '1', tags: ['x', 'y'] });
    const echo = await client.get('/headers-echo', { headers: { 'X-Custom': 'remote-value' } });
    expect(echo.get('headers.x-custom')).toBe('remote-value');
    expect(String(echo.get('headers.x-correlation-id'))).not.toBe('');
    const user = await client.get('/users/{id}', { pathParams: { id: 2 } });
    expect(user.get('name')).toBe('Grace Hopper');
    const form = await client.post('/form-echo', { form: { a: 'x y', b: 2 } });
    expect(JSON.stringify(form.body())).toContain('x y');
    expect(sent(-1).headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  test('4xx and 5xx bodies are returned, not thrown', async () => {
    const client = harness.client();
    const missing = await client.get('/users/99');
    expect(missing.status()).toBe(404);
    expect(missing.get('error')).toBe('not found');
    const down = await client.get('/always-503');
    expect(down.status()).toBe(503);
    expect(down.get('error')).toBe('down');
    expect(down.ok()).toBe(false);
  });

  test('binary bodies survive base64', async () => {
    const client = harness.client();
    const bytes = await (await client.get('/download/bytes')).bytes();
    expect([...bytes]).toEqual([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  });

  test('several Set-Cookie values joined by the agent are split again, an Expires comma is not a separator', () => {
    const reply = new RemoteApiResponse({
      status: 200,
      statusText: 'OK',
      headers: { 'Set-Cookie': 'a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; HttpOnly' },
      bodyBase64: '',
      url: 'http://x.test/',
      durationMs: 1,
    });
    expect(reply.headersArray().map((h) => h.value)).toEqual([
      'a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      'b=2; HttpOnly',
    ]);
  });

  test('failOnStatusCode throws, naming the call', async () => {
    await expect(harness.client().get('/users/99', { failOnStatusCode: true })).rejects.toThrow(/404 .*GET .*\/users\/99/);
  });

  test('HEAD works', async () => {
    const response = await harness.client().head('/users');
    expect(response.status()).toBe(200);
    expect(response.header('x-total-count')).toBe('3');
  });
});

test.describe('redirects, TLS, proxy and timeouts reach the agent @regression', () => {
  test('maxRedirects 0 returns the 302 itself; by default the redirect is followed', async () => {
    const client = harness.client();
    const stopped = await client.get('/redirect', { maxRedirects: 0 });
    expect(stopped.status()).toBe(302);
    expect(stopped.header('location')).toBe('/users/1');
    expect(sent(0).followRedirects).toBe(false);
    const followed = await client.get('/redirect');
    expect(followed.status()).toBe(200);
    expect(followed.get('name')).toBe('Ada Lovelace');
    expect(sent(1).followRedirects).toBe(true);
  });

  test('ignoreHTTPSErrors per call (and per context) becomes ignoreTlsErrors; the host proxy is off by default', async () => {
    const client = harness.client();
    await client.get('/users/1');
    await client.get('/users/1', { ignoreHTTPSErrors: true });
    await harness.client({ ignoreHTTPSErrors: true }).get('/users/1');
    expect(harness.sent.map((r) => r.ignoreTlsErrors)).toEqual([false, true, true]);
    expect(harness.sent.every((r) => r.useProxy === false)).toBe(true);
    await harness.client({ useProxy: true }).get('/users/1');
    expect(sent(-1).useProxy).toBe(true);
  });

  test('a per-request timeout ends a call the server never answers, with TIMEOUT named', async () => {
    const started = Date.now();
    const failure = await harness
      .client()
      .post('/oauth/hang', { json: {}, timeoutMs: 300 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(RemoteRequestError);
    expect((failure as RemoteRequestError).code).toBe('TIMEOUT');
    expect((failure as Error).message).toMatch(/remote host operation "http" timed out/);
    expect(sent(0).timeoutMs).toBe(300);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

test.describe('auth providers through the remote path @regression', () => {
  test('bearer: the right token passes, a wrong one is 401', async () => {
    const client = harness.client();
    expect((await client.scoped({ auth: new BearerAuth('expected-token') }).get('/protected/bearer')).status()).toBe(200);
    expect((await client.scoped({ auth: new BearerAuth('nope') }).get('/protected/bearer')).status()).toBe(401);
  });

  test('API key in a header and in the query', async () => {
    const client = harness.client();
    expect((await client.scoped({ auth: new ApiKeyAuth('X-Api-Key', 'expected-key') }).get('/protected/apikey')).status()).toBe(200);
    expect((await client.scoped({ auth: new ApiKeyAuth('apiKey', 'expected-key', 'query') }).get('/protected/apikey')).status()).toBe(200);
    expect((await client.scoped({ auth: new ApiKeyAuth('X-Api-Key', 'wrong') }).get('/protected/apikey')).status()).toBe(401);
  });

  test('OAuth2 client credentials: the token call goes through the remote host too, and is logged masked', async () => {
    const client = harness.client().setAuth(
      new OAuth2ClientCredentials({
        tokenUrl: `${harness.server.baseUrl}/oauth/token`,
        clientId: 'client',
        clientSecret: 'secret',
      }),
    );
    const response = await client.get('/protected/oauth');
    expect(response.status()).toBe(200);
    // one call for the token and one for the resource, both on the agent
    expect(harness.sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /oauth/token',
      'GET /protected/oauth',
    ]);
    expect(sent(0).headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const tokenCall = exchange(client, 0);
    expect(tokenCall.url).toContain('/oauth/token');
    expect(JSON.stringify(client.exchanges())).not.toContain('issued-token');
    expect(JSON.stringify(client.exchanges())).not.toContain('client_secret=secret');
  });

  test('a wrong client secret fails the token call with the identity provider status', async () => {
    const client = harness.client().setAuth(
      new OAuth2ClientCredentials({
        tokenUrl: `${harness.server.baseUrl}/oauth/token`,
        clientId: 'client',
        clientSecret: 'wrong',
      }),
    );
    await expect(client.get('/protected/oauth')).rejects.toThrow(/401|invalid_client/);
  });
});

test.describe('the client features keep working on the remote path @regression', () => {
  test('the exchange log masks credentials in headers and bodies', async () => {
    const client = harness.client().setAuth(new BearerAuth('super-secret-token-value'));
    await client.post('/users', { json: { name: 'Mask Me', password: 'hunter2-remote' } });
    const logged = exchange(client, 0);
    expect(logged.requestHeaders.Authorization).toBe(REDACTED);
    expect(logged.requestBody).not.toContain('hunter2-remote');
    expect(logged.requestBody).toContain(REDACTED);
    expect(logged.requestBody).toContain('Mask Me');
    expect(JSON.stringify(client.exchanges())).not.toContain('super-secret-token-value');
    // ...while the agent really received the true values (the mask is only for what is logged)
    expect(sent(0).headers?.Authorization).toBe('Bearer super-secret-token-value');
  });

  test('the retry policy retries a flaky endpoint through the agent', async () => {
    const id = key();
    const client = harness.client().setRetryPolicy({ attempts: 4, backoffMs: 1 });
    const response = await client.get(`/flaky/${id}`, { queryParams: { fail: 2 } });
    expect(response.status()).toBe(200);
    expect(response.get('calls')).toBe(3);
    expect(client.exchanges().map((e) => e.status)).toEqual([503, 503, 200]);
    expect(harness.agentHttpCalls()).toBe(3);
  });

  test('without a retry policy a 503 is returned once', async () => {
    const id = key();
    const response = await harness.client().get(`/flaky/${id}`, { queryParams: { fail: 2 } });
    expect(response.status()).toBe(503);
    expect(harness.agentHttpCalls()).toBe(1);
  });

  test('polling waits for a job to finish', async () => {
    const id = key();
    const response = await harness.client().poll('GET', `/jobs/${id}`, {
      until: (r) => r.get('state') === 'DONE',
      intervalsMs: [10],
      timeoutMs: 5000,
    });
    expect(response.get('state')).toBe('DONE');
    expect(harness.agentHttpCalls()).toBeGreaterThanOrEqual(3);
  });

  test('page-number and cursor pagination collect every item', async () => {
    const client = harness.client();
    const byPage = await paginateByPageNumber<{ id: number }>(client, '/page-items', {
      itemsPath: 'items',
      pageSize: { param: 'pageSize', size: 2 },
    });
    expect(byPage.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    const byCursor = await paginateByCursor<{ id: number }>(client, '/cursor-items', {
      itemsPath: 'items',
      nextCursorPath: 'next',
    });
    expect(byCursor.map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(harness.agentHttpCalls()).toBe(4 + 3);
  });
});

test.describe('what the remote path refuses or reports @regression', () => {
  test('multipart uploads throw a clear error and never reach the agent', async () => {
    const client = harness.client();
    await expect(
      client.post('/upload', { multipart: { note: 'hello', file: { buffer: Buffer.from('x'), fileName: 'a.txt' } } }),
    ).rejects.toThrow(/multipart.*not supported.*Run this call from the test machine/s);
    expect(harness.agentHttpCalls()).toBe(0);
  });

  test('storageState, client certificates and credentials are refused at construction', () => {
    for (const option of ['storageState', 'clientCertificates', 'httpCredentials'] as const)
      expect(() => new RemoteRequestContext(harness.host, { [option]: {} })).toThrow(
        new RegExp(`"${option}".*Run this call from the test machine`, 's'),
      );
  });

  test('a path without a base URL is refused instead of guessed', async () => {
    await expect(new RemoteRequestContext(harness.host).get('/users')).rejects.toThrow(/no base URL/);
  });

  test('DENIED when REMOTE_ALLOW lacks http names the setting', async () => {
    const denied = await startRemoteHarness({ allow: ['db'] });
    try {
      const failure = await denied
        .client()
        .get('/users')
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(RemoteRequestError);
      expect((failure as RemoteRequestError).code).toBe('DENIED');
      expect((failure as Error).message).toContain('REMOTE_ALLOW must include http');
      expect(denied.agentHttpCalls()).toBe(0);
    } finally {
      await denied.close();
    }
  });

  test('AGENT_STALE when the agent stops answering', async () => {
    const stale = await startRemoteHarness();
    try {
      expect((await stale.client().get('/users/1')).status()).toBe(200);
      await stale.agent.crash();
      const failure = await stale
        .client()
        .get('/users/1')
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(RemoteRequestError);
      expect((failure as RemoteRequestError).code).toBe('AGENT_STALE');
      expect((failure as Error).message).toMatch(/remote host operation "http" failed.*AGENT_STALE/s);
      expect((failure as RemoteRequestError).cause).toBeInstanceOf(remote.RemoteError);
    } finally {
      await stale.close();
    }
  });
});
