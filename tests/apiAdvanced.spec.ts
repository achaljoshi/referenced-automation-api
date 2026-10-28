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
import { BearerAuth } from '../src/auth/authProvider';
import { formatExchanges, redactBody, redactFields, redactHeaders } from '../src/client/exchange';
import { maskFields, subsetDifferences } from '../src/client/subset';
import { defaultPollTimeoutMs, mapConcurrent, pollUntil, PollTimeoutError } from '../src/util/poll';
import { safeUrl } from '../src/client/logging';
import { toCurl } from '../src/curl/toCurl';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';

// What stays here is the library itself: retry callbacks, poll errors and limits, response helpers and matchers, the
// exchange log and its masking, cleanup, curl. Retries, polling, redirects, GraphQL/SOAP and every authentication scheme
// as a person sees them are in features/ (retry-policy, resilience, protocols-and-redirects, authentication-*).
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
  test('a custom onStatus decides what is worth another try', async () => {
    const id = key();
    const response = await client.get(`/flaky/${id}?fail=1`, {
      retry: { attempts: 3, backoffMs: 1, onStatus: (status) => status === 503 },
    });
    expect(response.status()).toBe(200);
  });
});

test.describe('polling', () => {
  test('on timeout the error carries the last response, so the failure shows what the system said', async () => {
    const id = key();
    const error = await client
      .poll('GET', '/jobs/{id}?after=1000', {
        pathParams: { id },
        until: (r) => r.get('state') === 'DONE',
        intervalsMs: [5],
        // generous against a slow machine: with the old 60 ms a single slow request used up the whole budget and attempts was 1
        timeoutMs: 500,
        description: 'the job to finish',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect((error as PollTimeoutError).message).toMatch(/Poll timed out waiting for the job to finish/);
    expect((error as PollTimeoutError).message).toMatch(/last response: 200 .*PENDING/);
    expect((error as PollTimeoutError).attempts).toBeGreaterThan(1);
  });

  test.describe('the default poll limit leaves room before the test timeout @regression', () => {
    test.describe.configure({ timeout: 3000 });

    test('derived from the running test: at most 80% of what is left, and the poll fails first with its own message', async () => {
      expect(defaultPollTimeoutMs()).toBeLessThanOrEqual(2400);
      const startedAt = Date.now();
      const error = await pollUntil(
        async () => 'still waiting',
        () => false,
        { intervalsMs: [20], description: 'a thing that never happens' },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PollTimeoutError);
      expect((error as Error).message).toMatch(/Poll timed out waiting for a thing that never happens/);
      expect((error as Error).message).toMatch(/last response: "?still waiting/);
      // well inside the 3000 ms the test is allowed (the old default was 30 s, so "Test timeout" fired first)
      expect(Date.now() - startedAt).toBeLessThan(2900);
    });
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

test.describe('the exchange log hides credentials wherever they are @regression', () => {
  test('XML element values are masked by name, request and response, SOAP prefixes included', async () => {
    const scoped = new ApiClient(context, server.baseUrl);
    await scoped.post('/xml-echo', {
      xml: '<Login><User>ada</User><Password>hunter2</Password><soap:Token>tok-777</soap:Token><Card secret="4321">x</Card></Login>',
    });
    const [exchange] = scoped.exchanges();
    expect(exchange?.requestBody).toBe(
      '<Login><User>ada</User><Password>[REDACTED]</Password><soap:Token>[REDACTED]</soap:Token><Card secret="[REDACTED]">x</Card></Login>',
    );
    expect(exchange?.requestBody).not.toMatch(/hunter2|tok-777|4321/);

    // and a response: the token in a login answer, and the session cookie that comes with it
    const login = new ApiClient(context, server.baseUrl);
    await login.post('/login-xml', { xml: '<Login/>' });
    expect(login.exchanges()[0]?.responseBody).toBe(
      '<LoginResponse><Token>[REDACTED]</Token><User>ada</User></LoginResponse>',
    );
    expect(formatExchanges([...login.exchanges()])).not.toMatch(/live-token-value|live-session-value/);
  });

  test('a numeric secret is masked (password: 123456), and so is an object under a secret name', () => {
    expect(redactFields({ password: 123456, pin: 9999, token: { value: 'abc' }, retries: 3, authorized: true })).toEqual({
      password: '[REDACTED]',
      pin: 9999, // `pin` is not on the exchange list; the converter has its own
      token: '[REDACTED]',
      retries: 3,
      authorized: true,
    });
    expect(redactBody('{"password":123456,"name":"Ada"}', 'application/json')).toBe(
      '{"password":"[REDACTED]","name":"Ada"}',
    );
  });

  test('response headers are stored masked: Set-Cookie is not kept in the exchange', async () => {
    const scoped = new ApiClient(context, server.baseUrl);
    const response = await scoped.get('/cookies/set');
    expect(response.cookies().map((c) => c.name)).toContain('session'); // the response itself is untouched
    const exchange = scoped.exchanges()[0];
    expect(exchange?.responseHeaders?.['set-cookie']).toBe('[REDACTED]');
    expect(JSON.stringify(exchange)).not.toContain('abc123');
    expect(exchange?.responseHeaders?.['content-type']).toContain('json');
  });

  test('a token in the URL path is masked in the exchange, the log URL and a failure message', async () => {
    const token = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8'; // 36 characters, letters and digits
    const scoped = new ApiClient(context, server.baseUrl);
    await scoped.get(`/reset/${token}`);
    await scoped.get('/users/1');
    const [reset, users] = scoped.exchanges();
    expect(reset?.url).toBe(`${server.baseUrl}/reset/[REDACTED]`);
    expect(users?.url).toBe(`${server.baseUrl}/users/1`);
    const dead = new ApiClient(context, 'http://127.0.0.1:1');
    await dead.get(`/session/token/abc12345678/x?apiKey=live-key-99`).catch(() => undefined);
    expect(JSON.stringify(dead.exchanges())).not.toMatch(/abc12345678|live-key-99/);
  });

  test('safeUrl keeps ordinary ids and endpoints readable', () => {
    for (const url of [
      'https://h/users/42',
      'https://h/users/5f1d7f3e9b1a4c2d8e6f7a8b', // a 24-character object id
      'https://h/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301', // a UUID
      'https://h/auth/login',
      'https://h/token/refresh',
    ])
      expect(safeUrl(url)).toBe(url);
    expect(safeUrl('https://h/x/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).toBe('https://h/x/[REDACTED]');
    expect(safeUrl('/tokens/abcdef123456')).toBe('/tokens/[REDACTED]');
  });
});
