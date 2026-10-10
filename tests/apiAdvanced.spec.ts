import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiClient } from '../src/client/apiClient';
import { expect as apiExpect } from '../src/fixtures/apiMatchers';
import { CleanupRegistry } from '../src/fixtures/cleanup';
import {
  ApiKeyAuth,
  BearerAuth,
  CompositeAuth,
  HmacAuth,
  JwtAuth,
  OAuth2PasswordAuth,
  SessionCookieAuth,
} from '../src/auth/authProvider';
import { formatExchanges, redactBody, redactFields, redactHeaders } from '../src/client/exchange';
import { maskFields, subsetDifferences } from '../src/client/subset';
import { mapConcurrent, pollUntil, PollTimeoutError } from '../src/util/poll';
import { toCurl } from '../src/curl/toCurl';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';

let server: TestServerHandle;
let context: APIRequestContext;
let client: ApiClient;
let unique = 0;
const key = () => `k${Date.now()}-${unique++}`;

test.beforeAll(async () => {
  server = await startTestServer();
  context = await playwrightRequest.newContext();
  client = new ApiClient(context, server.baseUrl);
});

test.afterAll(async () => {
  await context.dispose();
  await stopTestServer(server);
});

test.describe('retry policy', () => {
  test('retries a throttled/unavailable response until it succeeds, and says so', async () => {
    const id = key();
    const response = await client.get(`/flaky/${id}`, { retry: { attempts: 4, backoffMs: 1 } });
    expect(response.status()).toBe(200);
    expect(response.get('calls')).toBe(3);
    const attempts = client.exchanges().filter((e) => e.url.includes(`/flaky/${id}`));
    expect(attempts.map((e) => [e.attempt, e.status])).toEqual([
      [1, 503],
      [2, 503],
      [3, 200],
    ]);
  });

  test('gives back the last response when the attempts run out - it never throws for a status', async () => {
    const response = await client.get('/always-503', { retry: { attempts: 2, backoffMs: 1 } });
    expect(response.status()).toBe(503);
  });

  test('a POST is not repeated by default - doing a thing twice is worse than failing once', async () => {
    const id = key();
    const response = await client.post(`/flaky-post/${id}`, {
      json: {},
      retry: { attempts: 3, backoffMs: 1 },
    });
    expect(response.status()).toBe(503);
    expect((await client.get(`/calls/flaky-post:${id}`)).get('calls')).toBe(1);
  });

  test('an idempotency key makes a POST safe to repeat, and is sent as the header', async () => {
    const id = key();
    const response = await client.post(`/flaky-post/${id}`, {
      json: {},
      idempotencyKey: 'order-42',
      retry: { attempts: 3, backoffMs: 1 },
    });
    expect(response.status()).toBe(201);
    expect(response.get('idempotencyKey')).toBe('order-42');
    const generated = await client.get('/echo-idempotency', { idempotencyKey: true });
    expect(generated.get<string>('key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a client-wide policy applies to every call and a per-call `retry: false` turns it off', async () => {
    const scoped = client.scoped().setRetryPolicy({ attempts: 3, backoffMs: 1 });
    const id = key();
    expect((await scoped.get(`/flaky/${id}`)).status()).toBe(200);
    const id2 = key();
    expect((await scoped.get(`/flaky/${id2}`, { retry: false })).status()).toBe(503);
  });

  test('a custom onStatus decides what is worth another try', async () => {
    const id = key();
    const response = await client.get(`/flaky/${id}?fail=1`, {
      retry: { attempts: 3, backoffMs: 1, onStatus: (status) => status === 503 },
    });
    expect(response.status()).toBe(200);
  });

  test('network errors are retried too, then thrown when they keep happening', async () => {
    const dead = new ApiClient(context, 'http://127.0.0.1:1');
    await expect(dead.get('/x', { retry: { attempts: 2, backoffMs: 1 } })).rejects.toThrow();
    expect(dead.exchanges().map((e) => e.attempt)).toEqual([1, 2]);
    expect(dead.exchanges().every((e) => e.error !== undefined && e.status === undefined)).toBe(
      true,
    );
  });
});

test.describe('polling', () => {
  test('client.poll repeats a request until the condition holds and returns that response', async () => {
    const id = key();
    const done = await client.poll('GET', '/jobs/{id}', {
      pathParams: { id },
      until: (r) => r.get('state') === 'DONE',
      intervalsMs: [1],
      timeoutMs: 5000,
    });
    expect(done.get('state')).toBe('DONE');
    expect(done.get('reads')).toBe(3);
  });

  test('on timeout the error carries the last response, so the failure shows what the system said', async () => {
    const id = key();
    const error = await client
      .poll('GET', '/jobs/{id}?after=1000', {
        pathParams: { id },
        until: (r) => r.get('state') === 'DONE',
        intervalsMs: [5],
        timeoutMs: 60,
        description: 'the job to finish',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect((error as PollTimeoutError).message).toMatch(/the job to finish/);
    expect((error as PollTimeoutError).message).toMatch(/PENDING/);
    expect((error as PollTimeoutError).attempts).toBeGreaterThan(1);
  });

  test('pollUntil works for any async value, and mapConcurrent limits how many run at once', async () => {
    let n = 0;
    expect(
      await pollUntil(
        async () => ++n,
        (v) => v >= 3,
        { intervalsMs: [1] },
      ),
    ).toBe(3);

    let inFlight = 0;
    let peak = 0;
    const results = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });
});

test.describe('conveniences', () => {
  test('getJson returns the typed body and throws readably on a failure', async () => {
    const users = await client.getJson<{ data: Array<{ name: string }> }>('/users');
    expect(users.data[0]?.name).toBe('Ada Lovelace');
    await expect(client.getJson('/users/999')).rejects.toThrow(
      /Expected status in \[200, 299\] but got 404/,
    );
  });

  test('getText returns the raw text', async () => {
    expect(await client.getText('/users')).toContain('Ada Lovelace');
  });

  test('download returns the exact bytes and can save them', async () => {
    const target = path.join(os.tmpdir(), `api-download-${Date.now()}`, 'blob.bin');
    const bytes = await client.download('/download/bytes', { saveTo: target });
    expect([...bytes]).toEqual([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...fs.readFileSync(target)]).toEqual([...bytes]);
  });

  test('graphql posts query, variables and operation name; errors come back with a 200', async () => {
    const ok = await client.graphql(
      'query Q($id: ID!) { user(id: $id) { name } }',
      { id: '1' },
      { operationName: 'Q' },
    );
    expect(ok.status()).toBe(200);
    ok.expectNoGraphqlErrors();
    expect(ok.get('data.echo.variables.id')).toBe('1');
    expect(ok.get('data.echo.operationName')).toBe('Q');
    const broken = await client.graphql('query { broken }');
    expect(broken.status()).toBe(200);
    expect(() => broken.expectNoGraphqlErrors()).toThrow(/GraphQL returned 1 error/);
  });

  test('soap wraps the body in an envelope with the right headers for 1.1 and 1.2', async () => {
    const v11 = await client.soap('/soap', { action: 'urn:Echo', body: '<Echo/>' });
    expect(v11.get('soap:Envelope.soap:Body.Echo.action')).toBe('"urn:Echo"');
    expect(v11.get('soap:Envelope.soap:Body.Echo.contentType')).toContain('text/xml');
    const v12 = await client.soap('/soap', { action: 'urn:Echo', body: '<Echo/>', version: '1.2' });
    expect(v12.get('soap:Envelope.soap:Body.Echo.contentType')).toContain('application/soap+xml');
  });

  test('maxRedirects: 0 returns the redirect itself, like curl without -L', async () => {
    const followed = await client.get('/redirect');
    expect(followed.status()).toBe(200);
    const notFollowed = await client.get('/redirect', { maxRedirects: 0 });
    expect(notFollowed.status()).toBe(302);
    expect(notFollowed.header('location')).toBe('/users/1');
  });

  test('setBaseUrl changes where relative paths go', async () => {
    const other = new ApiClient(context, 'http://127.0.0.1:1').setBaseUrl(server.baseUrl);
    expect(other.getBaseUrl()).toBe(server.baseUrl);
    expect((await other.get('/users')).status()).toBe(200);
  });

  test('scoped clients share the connection and exchange log but not headers or auth', async () => {
    const parent = new ApiClient(context, server.baseUrl).setHeader('X-Parent', '1');
    const child = parent.scoped({ headers: { 'X-Child': '2' } });
    const echoed = await child.get('/headers-echo');
    expect(echoed.get('headers.x-parent')).toBe('1');
    expect(echoed.get('headers.x-child')).toBe('2');
    expect((await parent.get('/headers-echo')).has('headers.x-child')).toBe(false);
    expect(parent.exchanges()).toHaveLength(2); // one log for both
    const noAuth = parent.setAuth(new BearerAuth('expected-token')).scoped({ auth: null });
    expect((await noAuth.get('/protected/bearer')).status()).toBe(401);
  });
});

test.describe('response helpers', () => {
  test('header, content type, body, subset, array length and timing assertions', async () => {
    const response = await client.get('/users');
    response
      .expectHeader('content-type', /json/)
      .expectContentType('JSON')
      .expectBodyContains('Ada')
      .expectMatches({ data: [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }, { id: 3 }] })
      .expectArrayLength('data', 3)
      .expectResponseTimeUnder(10_000);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(() => response.expectHeader('x-nope')).toThrow(/was not sent/);
    expect(() => response.expectHeader('content-type', 'text/plain')).toThrow(/to be text\/plain/);
    expect(() => response.expectContentType('xml')).toThrow(/Content-Type/);
    expect(() => response.expectBodyContains('Nobody')).toThrow(/to contain/);
    expect(() => response.expectMatches({ data: [{ name: 'Wrong' }, {}, {}] })).toThrow(
      /\$\.data\[0\]\.name: expected "Wrong", got "Ada Lovelace"/,
    );
    expect(() => response.expectArrayLength('data', 2)).toThrow(/has 3/);
    expect(() => response.expectResponseTimeUnder(-1)).toThrow(/within -1ms/);
  });

  test('bytes() are the raw payload and cookies() parses every Set-Cookie', async () => {
    const response = await client.get('/cookies/set');
    const cookies = response.cookies();
    expect(cookies.map((c) => c.name)).toEqual(['session', 'theme']);
    expect(cookies[0]).toMatchObject({
      value: 'abc123',
      attributes: { path: '/', httponly: true, secure: true },
    });
    expect(cookies[1]?.attributes['max-age']).toBe('3600');
    expect((await response.bytes()).toString()).toBe('{"set":true}');
  });

  test('snapshotText is stable: sorted keys, volatile fields masked', async () => {
    const response = await client.post('/users', { json: { name: 'Z', createdAt: 'now', id: 7 } });
    const text = response.snapshotText(['id', /At$/]);
    expect(text).toBe('{\n  "createdAt": "<masked>",\n  "id": "<masked>",\n  "name": "Z"\n}\n');
  });

  test('subsetDifferences and maskFields on their own', () => {
    expect(subsetDifferences({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toEqual([]);
    expect(subsetDifferences({ a: [1, 2] }, { a: [1] })).toEqual([
      '$.a: expected 1 item(s), got 2',
    ]);
    expect(subsetDifferences({ a: 1 }, { z: 1 })).toEqual(['$.z: missing']);
    expect(subsetDifferences('x', { a: 1 })).toEqual(['$: expected an object, got "x"']);
    expect(maskFields({ id: 1, nested: [{ id: 2, keep: 3 }] }, ['id'])).toEqual({
      id: '<masked>',
      nested: [{ id: '<masked>', keep: 3 }],
    });
  });
});

test.describe('custom matchers (apiExpect)', () => {
  test('pass and fail with messages that say what the service answered', async () => {
    const created = await client.post('/users', { json: { name: 'Ada', roles: ['admin'] } });
    await apiExpect(created).toHaveStatus(201);
    await apiExpect(created).toHaveStatus([200, 201]);
    await apiExpect(created).toBeSuccessful();
    await apiExpect(created).toHaveJsonPath('name', 'Ada');
    await apiExpect(created).toHaveJsonPath('roles[0]', 'admin');
    await apiExpect(created).toHaveJsonPath('id');
    await apiExpect(created).not.toHaveJsonPath('missing');
    await apiExpect(created).toMatchJsonSubset({ name: 'Ada', roles: ['admin'] });
    await apiExpect(created).toHaveResponseHeader('content-type', /json/);
    await apiExpect(created).toHaveResponseHeader('content-type');
    await apiExpect(created).toRespondWithin(10_000);
    await apiExpect(created).toMatchJsonSchema({ type: 'object', required: ['name'] });

    await expect(apiExpect(created).toHaveStatus(200)).rejects.toThrow(
      /Expected status 200 but got 201/,
    );
    await expect(apiExpect(created).toHaveJsonPath('name', 'Grace')).rejects.toThrow(
      /Expected "name" to equal "Grace" but got "Ada"/,
    );
    await expect(apiExpect(created).toHaveJsonPath('nope')).rejects.toThrow(/to be present/);
    await expect(apiExpect(created).toMatchJsonSubset({ name: 'X' })).rejects.toThrow(
      /does not match the expected subset/,
    );
    await expect(apiExpect(created).toHaveResponseHeader('x-missing')).rejects.toThrow(
      /was not sent/,
    );
    await expect(
      apiExpect(created).toMatchJsonSchema({ type: 'object', required: ['absent'] }),
    ).rejects.toThrow(/schema validation/);
    await expect(apiExpect(created).toRespondWithin(-1)).rejects.toThrow(/within -1ms/);
    const missing = await client.get('/users/999');
    await expect(apiExpect(missing).toBeSuccessful()).rejects.toThrow(
      /Expected a 2xx response but got 404/,
    );
    await apiExpect(missing).not.toBeSuccessful();
  });
});

test.describe('more auth strategies', () => {
  test('CompositeAuth applies every provider', async () => {
    const both = new ApiClient(context, server.baseUrl).setAuth(
      new CompositeAuth(
        new ApiKeyAuth('X-API-Key', 'expected-key'),
        new BearerAuth('expected-token'),
      ),
    );
    const echoed = await both.get('/headers-echo');
    expect(echoed.get('headers.x-api-key')).toBe('expected-key');
    expect(echoed.get('headers.authorization')).toBe('Bearer expected-token');
  });

  test('OAuth2PasswordAuth logs in, reuses the token, then refreshes with the refresh token when it expires', async () => {
    const auth = new OAuth2PasswordAuth({
      tokenUrl: `${server.baseUrl}/oauth/password-token`,
      username: 'ada',
      password: 'lovelace',
      refreshSkewSeconds: 0,
    });
    const authed = new ApiClient(context, server.baseUrl).setAuth(auth);
    expect((await authed.get('/protected/oauth-password')).get('token')).toBe(
      'Bearer password-token',
    );
    // the issued token lives 1 second: after that the refresh token is used
    await expect
      .poll(async () => (await authed.get('/protected/oauth-password')).get('token'), {
        timeout: 5000,
        intervals: [250],
      })
      .toBe('Bearer refreshed-token');
  });

  test("OAuth2PasswordAuth with a wrong password fails with the server's answer", async () => {
    const auth = new OAuth2PasswordAuth({
      tokenUrl: `${server.baseUrl}/oauth/password-token`,
      username: 'ada',
      password: 'wrong',
    });
    await expect(
      new ApiClient(context, server.baseUrl).setAuth(auth).get('/protected/oauth-password'),
    ).rejects.toThrow(/password grant failed: 401/);
  });

  test('JwtAuth signs a fresh HS256 token the service accepts; the wrong secret is rejected', async () => {
    const good = new ApiClient(context, server.baseUrl).setAuth(
      new JwtAuth({ secret: 'jwt-secret', claims: { sub: 'ada' } }),
    );
    const ok = await good.get('/protected/jwt');
    expect(ok.status()).toBe(200);
    expect(ok.get('sub')).toBe('ada');
    const bad = new ApiClient(context, server.baseUrl).setAuth(
      new JwtAuth({ secret: 'other', claims: { sub: 'ada' } }),
    );
    expect((await bad.get('/protected/jwt')).status()).toBe(401);
    const expired = new ApiClient(context, server.baseUrl).setAuth(
      new JwtAuth({ secret: 'jwt-secret', claims: { sub: 'ada' }, expiresInSeconds: -60 }),
    );
    expect((await expired.get('/protected/jwt')).get('error')).toBe('expired');
  });

  test('HmacAuth signs method, path, query and body - tampering with any of them is rejected', async () => {
    const signed = new ApiClient(context, server.baseUrl).setAuth(
      new HmacAuth({ keyId: 'key-1', secret: 'hmac-secret' }),
    );
    expect((await signed.get('/protected/hmac', { queryParams: { a: '1' } })).status()).toBe(200);
    expect((await signed.post('/protected/hmac', { json: { amount: 5 } })).status()).toBe(200);
    const wrong = new ApiClient(context, server.baseUrl).setAuth(
      new HmacAuth({ keyId: 'key-1', secret: 'not-the-secret' }),
    );
    expect((await wrong.get('/protected/hmac')).status()).toBe(401);
  });

  test('SessionCookieAuth logs in once and sends the session cookie after', async () => {
    const auth = new SessionCookieAuth({
      loginUrl: `${server.baseUrl}/session/login`,
      credentials: { username: 'ada', password: 'lovelace' },
    });
    const session = new ApiClient(context, server.baseUrl).setAuth(auth);
    expect((await session.get('/protected/session')).status()).toBe(200);
    expect((await session.get('/protected/session')).status()).toBe(200);
    const wrong = new ApiClient(context, server.baseUrl).setAuth(
      new SessionCookieAuth({
        loginUrl: `${server.baseUrl}/session/login`,
        credentials: { username: 'ada', password: 'no' },
      }),
    );
    await expect(wrong.get('/protected/session')).rejects.toThrow(/Session login failed: 401/);
  });
});

test.describe('exchange log, redaction and curl', () => {
  test('every call is recorded with credentials masked, bodies included', async () => {
    const scoped = new ApiClient(context, server.baseUrl).setAuth(
      new BearerAuth('super-secret-token'),
    );
    await scoped.post('/users', {
      json: { name: 'Ada', password: 'hunter2' },
      queryParams: { apiKey: 'qk-123', page: 1 },
    });
    const [exchange] = scoped.exchanges();
    expect(exchange?.method).toBe('POST');
    expect(exchange?.status).toBe(201);
    expect(exchange?.requestHeaders.Authorization).toBe('[REDACTED]');
    expect(exchange?.url).toContain('apiKey=[REDACTED]');
    expect(exchange?.url).toContain('page=1');
    expect(exchange?.requestBody).toBe('{"name":"Ada","password":"[REDACTED]"}');
    const everything = formatExchanges([...scoped.exchanges()]);
    expect(everything).not.toContain('super-secret-token');
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('qk-123');
    expect(everything).toContain('POST');
  });

  test('onExchange is called as calls complete and stops when unsubscribed', async () => {
    const seen: string[] = [];
    const scoped = new ApiClient(context, server.baseUrl);
    const stop = scoped.onExchange((e) => seen.push(`${e.method} ${e.status}`));
    await scoped.get('/users');
    stop();
    await scoped.get('/users');
    expect(seen).toEqual(['GET 200']);
    scoped.clearExchanges();
    expect(scoped.exchanges()).toHaveLength(0);
  });

  test('redaction helpers', () => {
    expect(redactHeaders({ Authorization: 'x', 'X-Api-Key': 'y', Accept: 'z' })).toEqual({
      Authorization: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      Accept: 'z',
    });
    expect(redactFields({ user: { password: 'p', name: 'n' }, list: [{ token: 't' }] })).toEqual({
      user: { password: '[REDACTED]', name: 'n' },
      list: [{ token: '[REDACTED]' }],
    });
    expect(redactBody('password=p&name=n', 'application/x-www-form-urlencoded')).toBe(
      'password=%5BREDACTED%5D&name=n',
    );
    expect(redactBody('not json {', 'text/plain')).toBe('not json {');
    expect(redactBody(undefined, undefined)).toBeUndefined();
  });

  test('toCurl produces a pasteable command with credentials masked and quotes escaped', () => {
    const command = toCurl({
      method: 'post',
      url: 'http://x.test/a?b=1',
      headers: { Authorization: 'Bearer abc', Accept: 'application/json' },
      body: `{"n":"it's"}`,
    });
    expect(command).toBe(
      `curl -X POST 'http://x.test/a?b=1' -H 'Authorization: [REDACTED]' -H 'Accept: application/json' --data-raw '{"n":"it'\\''s"}'`,
    );
    expect(
      toCurl(
        { method: 'GET', url: 'http://x.test', headers: { Authorization: 'Bearer abc' } },
        { redact: false },
      ),
    ).toContain('Bearer abc');
  });
});

test.describe('CleanupRegistry', () => {
  test('runs undo steps newest first, keeps going after a failure, then reports every failure', async () => {
    const order: string[] = [];
    const registry = new CleanupRegistry();
    registry.add('first', () => void order.push('first'));
    registry.add('second (fails)', () => {
      order.push('second');
      throw new Error('boom');
    });
    registry.add('third', async () => void order.push('third'));
    expect(registry.pending).toBe(3);
    await expect(registry.run()).rejects.toThrow(
      /1 cleanup step\(s\) failed:\n {2}second \(fails\): boom/,
    );
    expect(order).toEqual(['third', 'second', 'first']);
    expect(registry.pending).toBe(0);
    await registry.run(); // nothing left: a no-op
  });
});
