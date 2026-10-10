import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../src/client/apiClient';
import { paginateByCursor, paginateByPageNumber } from '../src/pagination/paginate';
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

test.describe('pagination fails loudly instead of returning partial data @regression', () => {
  test('a non-2xx page throws with the page number and status (it used to end the loop with page 1 only)', async () => {
    await expect(
      paginateByPageNumber(client, '/paged/fail-on-2', { itemsPath: 'items' }),
    ).rejects.toThrow(/failed on page 2: status 500/);
    await expect(paginateByCursor(client, '/paged/cursor-401', { itemsPath: 'items', nextCursorPath: 'next' })).rejects.toThrow(
      /failed on page 2 \(cursor "c2"\): status 401/,
    );
  });

  test('hitting maxPages with more data left throws, naming the cap', async () => {
    await expect(
      paginateByPageNumber(client, '/paged/endless', { itemsPath: 'items', maxPages: 3 }),
    ).rejects.toThrow(/stopped after maxPages \(3\) with more data/);
    await expect(
      paginateByCursor(client, '/paged/cursor-endless', {
        itemsPath: 'items',
        nextCursorPath: 'next',
        maxPages: 3,
      }),
    ).rejects.toThrow(/stopped after maxPages \(3\)/);
  });

  test('allowTruncation returns what was read instead', async () => {
    const items = await paginateByPageNumber(client, '/paged/endless', {
      itemsPath: 'items',
      maxPages: 3,
      allowTruncation: true,
    });
    expect(items).toHaveLength(6);
    const viaCursor = await paginateByCursor(client, '/paged/cursor-endless', {
      itemsPath: 'items',
      nextCursorPath: 'next',
      maxPages: 2,
      allowTruncation: true,
    });
    expect(viaCursor).toHaveLength(4);
  });

  test('a cap that is reached exactly when the data ends is not an error', async () => {
    // 5 items, 2 per page: pages 1-3 read everything, and page 3 is short, so stopping there is a normal end
    const items = await paginateByPageNumber(client, '/page-items', {
      itemsPath: 'items',
      pageSize: { param: 'pageSize', size: 2 },
      stopWhenFewerThan: 2,
      maxPages: 3,
    });
    expect(items).toHaveLength(5);
  });

  test("an empty-string cursor is the end ('' is how many APIs say 'no more')", async () => {
    const items = await paginateByCursor(client, '/paged/cursor-empty-end', {
      itemsPath: 'items',
      nextCursorPath: 'next',
    });
    expect(items.map((i) => (i as { id: number }).id)).toEqual([11, 12, 21, 22]);
  });

  test('a cursor that comes back again is a loop: it throws instead of running to maxPages', async () => {
    await expect(
      paginateByCursor(client, '/paged/cursor-loop', { itemsPath: 'items', nextCursorPath: 'next' }),
    ).rejects.toThrow(/cursor "same" came back again on page 2 \(cursor "same"\)/);
  });

  test('an items path that is not an array is an error', async () => {
    await expect(
      paginateByPageNumber(client, '/page-items', { itemsPath: 'items.0', maxPages: 1 }),
    ).rejects.toThrow(/is not an array/);
  });
});
