import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { MockServer } from '../../src/mock/mockServer';

let server: MockServer;
let context: APIRequestContext;

test.beforeAll(async () => {
  server = new MockServer();
  await server.start();
  context = await playwrightRequest.newContext();
});

test.afterAll(async () => {
  await context.dispose();
  await server.stop();
});

test.describe('MockServer @smoke', () => {
  test('serves a static JSON body with the default 200 status', async () => {
    server.get('/ping', { ok: true });

    const res = await context.get(`${server.baseUrl}/ping`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('serves a body computed from the request via a handler function', async () => {
    server.get('/users/:id', (req) => ({ id: Number(req.params.id), name: 'Ada' }));

    const res = await context.get(`${server.baseUrl}/users/42`);
    expect(await res.json()).toEqual({ id: 42, name: 'Ada' });
  });

  test('supports a custom status and headers via the convenience methods', async () => {
    server.post('/rejected', { error: 'nope' }, { status: 422, headers: { 'X-Mock': 'true' } });

    const res = await context.post(`${server.baseUrl}/rejected`, { data: {} });
    expect(res.status()).toBe(422);
    expect(res.headers()['x-mock']).toBe('true');
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  test('route() gives full control over status/headers/body computed together', async () => {
    server.route({
      method: 'POST',
      path: '/orders',
      handler: (req) => ({
        status: 201,
        headers: { 'X-Created': 'true' },
        body: { id: 1, ...(req.body as Record<string, unknown>) },
      }),
    });

    const res = await context.post(`${server.baseUrl}/orders`, { data: { item: 'widget' } });
    expect(res.status()).toBe(201);
    expect(res.headers()['x-created']).toBe('true');
    expect(await res.json()).toEqual({ id: 1, item: 'widget' });
  });

  test('returns a JSON 404 for a route nothing registered', async () => {
    const res = await context.get(`${server.baseUrl}/does-not-exist`);
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual(
      expect.objectContaining({ error: expect.stringContaining('/does-not-exist') }),
    );
  });

  test('reset() clears every previously registered mock', async () => {
    server.get('/temp', { temp: true });
    expect((await context.get(`${server.baseUrl}/temp`)).status()).toBe(200);

    server.reset();
    expect((await context.get(`${server.baseUrl}/temp`)).status()).toBe(404);
  });

  test('delayMs delays the response by roughly the configured amount', async () => {
    server.get('/slow', { ok: true }, { delayMs: 200 });

    const start = Date.now();
    await context.get(`${server.baseUrl}/slow`);
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
  });
});
