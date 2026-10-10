import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient, joinUrl } from '../src/client/apiClient';
import { BearerAuth, HmacAuth } from '../src/auth/authProvider';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';

// A gateway-style base URL (https://host/api/v1): the path of the base URL must survive, a full URL in place of a path
// must be refused, and a placeholder with no value must not be sent as it is.
let gateway: TestServerHandle;
let other: TestServerHandle;
let context: APIRequestContext;

test.beforeAll(async () => {
  gateway = await startTestServer({ prefix: '/api/v1' });
  other = await startTestServer();
  context = await playwrightRequest.newContext();
});

test.afterAll(async () => {
  await context.dispose();
  await stopTestServer(gateway);
  await stopTestServer(other);
});

test.describe('base URL with a path prefix @regression', () => {
  test('joinUrl keeps the base path, uses one slash and keeps the query', () => {
    expect(joinUrl('https://h/api/v1', '/users')).toBe('https://h/api/v1/users');
    expect(joinUrl('https://h/api/v1/', '/users')).toBe('https://h/api/v1/users');
    expect(joinUrl('https://h/api/v1', 'users')).toBe('https://h/api/v1/users');
    expect(joinUrl('https://h/api/v1//', '//users')).toBe('https://h/api/v1/users');
    expect(joinUrl('https://h', '/users?x=1#top')).toBe('https://h/users?x=1#top');
    expect(joinUrl('https://h/api', '/')).toBe('https://h/api/');
  });

  test('a path is sent under the base URL prefix (the old join sent /users and dropped /api/v1)', async () => {
    const client = new ApiClient(context, gateway.baseUrl);
    const response = await client.get('/users');
    expect(response.status()).toBe(200);
    expect(response.get('data[0].name')).toBe('Ada Lovelace');
    expect(gateway.requests.at(-1)?.url).toBe('/api/v1/users');
  });

  test('a trailing slash on the base URL and a path without a leading slash give the same URL', async () => {
    const client = new ApiClient(context, `${gateway.baseUrl}/`);
    const response = await client.get('users/{id}', { pathParams: { id: 2 } });
    expect(response.get('name')).toBe('Grace Hopper');
    expect(gateway.requests.at(-1)?.url).toBe('/api/v1/users/2');
  });

  test('a negative test gets the APPLICATION 404, not the gateway one - the prefix is really there', async () => {
    const client = new ApiClient(context, gateway.baseUrl);
    const missing = await client.get('/users/{id}', { pathParams: { id: 999 } });
    expect(missing.status()).toBe(404);
    expect(missing.get('error')).toBe('not found'); // the route ran: a missing prefix would give an HTML 404 from the router

    // The same server called WITHOUT the prefix is a 404 with no application body: that is what the old join produced for every call.
    const bare = new ApiClient(context, gateway.origin);
    const wrong = await bare.get('/users');
    expect(wrong.status()).toBe(404);
    expect(wrong.has('data')).toBe(false);
  });

  test('query parameters and a query in the path are kept', async () => {
    const client = new ApiClient(context, gateway.baseUrl);
    const response = await client.get('/search?fixed=1', { queryParams: { q: 'ada' } });
    expect(response.get('query.fixed')).toBe('1');
    expect(response.get('query.q')).toBe('ada');
  });

  test('a signature covers the real path, prefix included', async () => {
    const client = new ApiClient(context, gateway.baseUrl).setAuth(
      new HmacAuth({ keyId: 'key-1', secret: 'hmac-secret' }),
    );
    const response = await client.get('/protected/hmac');
    expect(response.status()).toBe(200);
  });
});

test.describe('a full URL in place of a path @regression', () => {
  test('is refused, and nothing - no auth header either - reaches that host', async () => {
    const client = new ApiClient(context, gateway.baseUrl).setAuth(new BearerAuth('live-token'));
    await expect(client.get(`${other.origin}/headers-echo`)).rejects.toThrow(/Refusing to send to the full URL/);
    await expect(client.get('//evil.test/x')).rejects.toThrow(/Refusing/);
    await expect(client.post('https://evil.test/x', { json: { a: 1 } })).rejects.toThrow(/absoluteUrl: true/);
    expect(other.requests).toHaveLength(0);
    expect(client.exchanges()).toHaveLength(0);
  });

  test('is sent when the call says absoluteUrl: true', async () => {
    const client = new ApiClient(context, gateway.baseUrl);
    const response = await client.get(`${other.origin}/users/1`, { absoluteUrl: true });
    expect(response.get('name')).toBe('Ada Lovelace');
    expect(other.requests.at(-1)?.url).toBe('/users/1');
  });

  test('a path that merely contains a colon is still a path', async () => {
    const client = new ApiClient(context, gateway.baseUrl);
    const response = await client.get('/search?next=http://x.test/a', {});
    expect(response.status()).toBe(200);
  });
});

test.describe('placeholders without a value @regression', () => {
  test('{id} with no pathParams is an error, not a request for the literal /users/{id}', async () => {
    const client = new ApiClient(context, gateway.baseUrl);
    const before = gateway.requests.length;
    await expect(client.get('/users/{id}')).rejects.toThrow(/Missing path param "id"/);
    expect(gateway.requests).toHaveLength(before);
  });

  test('a missing key among the given pathParams still throws', async () => {
    const client = new ApiClient(context, gateway.baseUrl);
    await expect(
      client.get('/users/{id}/orders/{orderId}', { pathParams: { id: 1 } }),
    ).rejects.toThrow(/Missing path param "orderId"/);
  });
});
