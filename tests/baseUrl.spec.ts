import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient, joinUrl } from '../src/client/apiClient';
import { BearerAuth } from '../src/auth/authProvider';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';

// What stays here is the client's own guard rails: how a base URL and a path are joined, a full URL handed to the client
// in place of a path (refused), and a placeholder with no value. What a person sees of a gateway-style base URL
// (https://host/api/v1: the prefix is kept, query data survives, signatures cover it, a step may name a full URL) is in
// features/base-url.feature.
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
