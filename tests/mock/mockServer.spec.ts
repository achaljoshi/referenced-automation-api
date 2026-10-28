import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import * as os from 'node:os';
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

// Answers written as data (a static body, a status, headers, a delay, a 404, reset) are in features/mock-service.feature.
// What stays here takes a JavaScript function (a handler computed from the request) or is about the server itself.
test.describe('MockServer @smoke', () => {
  test('serves a body computed from the request via a handler function', async () => {
    server.get('/users/:id', (req) => ({ id: Number(req.params.id), name: 'Ada' }));

    const res = await context.get(`${server.baseUrl}/users/42`);
    expect(await res.json()).toEqual({ id: 42, name: 'Ada' });
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
});

test.describe('MockServer is local, survives a throwing handler and stops promptly @regression', () => {
  const externalAddress = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  test('listens on 127.0.0.1 only: the machine\'s own network address is refused', async () => {
    test.skip(externalAddress === undefined, 'this machine has no non-loopback IPv4 address to probe');
    const own = new MockServer();
    await own.start();
    try {
      const port = new URL(own.baseUrl).port;
      expect(new URL(own.baseUrl).hostname).toBe('127.0.0.1');
      await expect(context.get(`http://${externalAddress}:${port}/x`, { timeout: 3000 })).rejects.toThrow(
        /ECONNREFUSED|ECONNRESET|connect/i,
      );
    } finally {
      await own.stop();
    }
  });

  test('a handler that throws answers 500 with the message, sync or async (it used to hang the request)', async () => {
    const own = new MockServer();
    await own.start();
    try {
      own.get('/boom', () => {
        throw new Error('handler exploded');
      });
      own.route({
        method: 'POST',
        path: '/boom-async',
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error('async handler exploded');
        },
      });
      const sync = await context.get(`${own.baseUrl}/boom`, { timeout: 3000 });
      expect(sync.status()).toBe(500);
      expect(await sync.json()).toEqual({ error: 'Mock handler threw: handler exploded' });
      const async_ = await context.post(`${own.baseUrl}/boom-async`, { data: {}, timeout: 3000 });
      expect(async_.status()).toBe(500);
      expect((await async_.json()).error).toContain('async handler exploded');
      // and the server is still fine afterwards
      own.get('/ok', { ok: true });
      expect((await context.get(`${own.baseUrl}/ok`)).status()).toBe(200);
    } finally {
      await own.stop();
    }
  });

  test('stop() does not wait for a request that is still in flight', async () => {
    const own = new MockServer();
    await own.start();
    let arrived = false;
    own.get('/hangs', () => {
      arrived = true;
      return new Promise(() => undefined); // never answers
    });
    const pending = context.get(`${own.baseUrl}/hangs`, { timeout: 20_000 }).catch((e: Error) => e);
    await expect.poll(() => arrived).toBe(true);
    const startedAt = Date.now();
    await own.stop();
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect((await pending) instanceof Error).toBe(true); // the client sees the connection drop
  });

  test('stop() is safe to call twice, and a server that is not started stops without error', async () => {
    const own = new MockServer();
    await own.stop();
    await own.start();
    await own.stop();
    await own.stop();
  });

  test('start() rejects when the port is taken (it used to wait forever)', async () => {
    const first = new MockServer();
    await first.start();
    try {
      const second = new MockServer();
      await expect(second.start(Number(new URL(first.baseUrl).port))).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await first.stop();
    }
  });
});
