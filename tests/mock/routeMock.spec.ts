import { test, expect } from '@playwright/test';
import { mockApiRoute } from '../../src/mock/routeMock';

// `*.invalid` is reserved by RFC 2606 to never resolve on a real network -
// so any of these tests passing proves the mock intercepted the request,
// not that it happened to reach a real server that returned the same thing.
const INVALID_HOST = 'http://api.invalid';

test.describe('mockApiRoute @smoke', () => {
  test('fulfills a matching request with a static JSON body, no network involved', async ({ page }) => {
    await mockApiRoute(page, {
      url: '**/users',
      method: 'GET',
      body: { data: [{ id: 1, name: 'Mocked Ada' }] },
    });

    await page.goto(`${INVALID_HOST}/users`);
    const text = await page.locator('body').innerText();
    expect(JSON.parse(text)).toEqual({ data: [{ id: 1, name: 'Mocked Ada' }] });
  });

  test('supports a dynamic body function and a custom status', async ({ page }) => {
    await mockApiRoute(page, {
      url: '**/users/*',
      body: (request) => ({ id: Number(new URL(request.url()).pathname.split('/').pop()), name: 'Dynamic' }),
      status: 201,
    });

    const response = await page.goto(`${INVALID_HOST}/users/42`);
    expect(response?.status()).toBe(201);
    const text = await page.locator('body').innerText();
    expect(JSON.parse(text)).toEqual({ id: 42, name: 'Dynamic' });
  });

  test('only intercepts the configured method - other methods fall through unmocked', async ({ page }) => {
    await page.goto('about:blank');
    await mockApiRoute(page, {
      url: `${INVALID_HOST}/users`,
      method: 'GET',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: { data: ['mocked-get'] },
    });

    const getResult = await page.evaluate(async (url) => {
      const res = await fetch(url);
      return res.json();
    }, `${INVALID_HOST}/users`);
    expect(getResult).toEqual({ data: ['mocked-get'] });

    // A POST to the same URL isn't mocked, so it falls through to the real
    // network - which can never succeed against a *.invalid host. If the
    // GET-only filter leaked, this would resolve with the GET mock's body
    // instead of rejecting.
    const postWasRejected = await page.evaluate(async (url) => {
      try {
        await fetch(url, { method: 'POST' });
        return false;
      } catch {
        return true;
      }
    }, `${INVALID_HOST}/users`);
    expect(postWasRejected).toBe(true);
  });
});
