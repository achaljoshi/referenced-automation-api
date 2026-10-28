import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../src/client/apiClient';
import { BearerAuth } from '../src/auth/authProvider';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';

let server: TestServerHandle;
let context: APIRequestContext;
let client: ApiClient;

test.beforeAll(async () => {
  server = await startTestServer();
  context = await playwrightRequest.newContext();
  client = new ApiClient(context, server.baseUrl);
});

test.afterAll(async () => {
  await context.dispose();
  await stopTestServer(server);
});

// What stays here is the ApiClient's own API (header get/remove, array query values, {path} parameters, an XML body built
// from an object, in-memory multipart, response helpers, a token supplier function, the correlation id). The requests a
// person recognises (each method, forms, XML, uploads, authentication, pagination) are in features/ - see the README.
test.describe('headers CRUD', () => {
  test('default headers persist across calls and can be read/removed', async () => {
    const scoped = new ApiClient(context, server.baseUrl);
    scoped.setHeader('X-Trace-Id', 'trace-123');
    expect(scoped.getHeader('X-Trace-Id')).toBe('trace-123');

    const response = await scoped.get('/headers-echo');
    expect(response.get('headers.x-trace-id')).toBe('trace-123');

    scoped.removeHeader('X-Trace-Id');
    expect(scoped.getHeader('X-Trace-Id')).toBeUndefined();
    const afterRemove = await scoped.get('/headers-echo');
    expect(afterRemove.has('headers.x-trace-id')).toBe(false);
  });

  test('per-request headers override without mutating the client defaults', async () => {
    const scoped = new ApiClient(context, server.baseUrl).setHeader('X-Env', 'default');
    const response = await scoped.get('/headers-echo', { headers: { 'X-Env': 'override' } });
    expect(response.get('headers.x-env')).toBe('override');
    expect(scoped.getHeader('X-Env')).toBe('default');
  });
});

test.describe('query and path params', () => {
  test('query params are sent, including repeated array values', async () => {
    const response = await client.get('/search', {
      queryParams: { q: 'ada', tags: ['admin', 'user'] },
    });
    expect(response.get('query.q')).toBe('ada');
    expect(response.get('query.tags')).toEqual(['admin', 'user']);
  });

  test('path params are substituted into {placeholders}', async () => {
    const response = await client.get('/users/{id}', { pathParams: { id: 2 } });
    expect(response.get('name')).toBe('Grace Hopper');
  });

  test('throws a clear error for a missing path param', async () => {
    await expect(client.get('/users/{id}', { pathParams: {} })).rejects.toThrow(/Missing path param/);
  });
});

test.describe('request body formats', () => {
  test('xml body is sent and the xml response is traversable', async () => {
    const response = await client.post('/xml-echo', { xml: { user: { id: 1, name: 'Ada' } } });
    expect(response.header('content-type')).toContain('xml');
    expect(response.get('echo.received')).toContain('Ada');
  });

  test('multipart body sends fields and a file together', async () => {
    const response = await client.post('/upload', {
      multipart: {
        description: 'a test file',
        file: {
          fileName: 'hello.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('hello world'),
        },
      },
    });
    expect(response.get('fields.description')).toBe('a test file');
    expect(response.get('file.originalname')).toBe('hello.txt');
    expect(response.get('file.size')).toBe(11);
  });
});

test.describe('response validation', () => {
  test('expectStatus/expectValue/expectSchema chain fluently', async () => {
    const response = await client.get('/users/{id}', { pathParams: { id: 1 } });
    response
      .expectStatus(200)
      .expectValue('name', 'Ada Lovelace')
      .expectSchema({
        type: 'object',
        required: ['id', 'name', 'email'],
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
      });
  });

  test('expectStatus throws a readable error on mismatch', async () => {
    const response = await client.get('/users/{id}', { pathParams: { id: 999 } });
    expect(() => response.expectStatus(200)).toThrow(/Expected status 200 but got 404/);
  });
});

test.describe('auth strategies', () => {
  test('BearerAuth authenticates with a token supplier function', async () => {
    const scoped = new ApiClient(context, server.baseUrl).setAuth(
      new BearerAuth(() => 'expected-token'),
    );
    const response = await scoped.get('/protected/bearer');
    expect(response.get('authenticated')).toBe(true);
  });
});

import { CORRELATION_HEADER, safeUrl } from '../src';
import { getCorrelationId, setCorrelationId } from '@automation/referenced-automation-utils';

test.describe('correlation id and request logging', () => {
  test.afterEach(() => setCorrelationId(undefined));

  test('every request carries an X-Correlation-Id header, minted per request when no test id is active', async () => {
    const first = await client.get('/headers-echo');
    const second = await client.get('/headers-echo');
    const a = first.get<string>(`headers.${CORRELATION_HEADER.toLowerCase()}`);
    const b = second.get<string>(`headers.${CORRELATION_HEADER.toLowerCase()}`);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  test('uses the active correlation id for every call, so one flow shares one id', async () => {
    setCorrelationId('flow-1234');
    const a = await client.get('/headers-echo');
    const b = await client.get('/headers-echo');
    expect(a.get(`headers.${CORRELATION_HEADER.toLowerCase()}`)).toBe('flow-1234');
    expect(b.get(`headers.${CORRELATION_HEADER.toLowerCase()}`)).toBe('flow-1234');
    expect(getCorrelationId()).toBe('flow-1234');
  });

  test('a correlation header set by the caller is never overwritten', async () => {
    const response = await client.get('/headers-echo', { headers: { [CORRELATION_HEADER]: 'caller-supplied' } });
    expect(response.get(`headers.${CORRELATION_HEADER.toLowerCase()}`)).toBe('caller-supplied');
  });
});

test.describe('safeUrl - never logs a credential from the query string', () => {
  test('masks credential-looking params and keeps the rest', () => {
    expect(safeUrl('https://api.example.test/users?page=2&apiKey=live-key&access_token=abc&q=ada')).toBe(
      'https://api.example.test/users?page=2&apiKey=[REDACTED]&access_token=[REDACTED]&q=ada',
    );
    expect(safeUrl('/search?signature=zzz&limit=5')).toBe('/search?signature=[REDACTED]&limit=5');
  });

  test('leaves a URL with no query string alone', () => {
    expect(safeUrl('https://api.example.test/users/42')).toBe('https://api.example.test/users/42');
  });
});
