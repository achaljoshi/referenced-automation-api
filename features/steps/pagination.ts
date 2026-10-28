import * as assert from 'node:assert';
import { createBdd } from 'playwright-bdd';
import { paginateByCursor, paginateByPageNumber } from '../../src/pagination/paginate';
import type { ApiClient } from '../../src/client/apiClient';
import { test } from './fixtures';

const { When, Then } = createBdd(test);

type Options = Record<string, string>;

function number(options: Options, key: string): number | undefined {
  return options[key] === undefined ? undefined : Number(options[key]);
}

function required(options: Options, key: string): string {
  const value = options[key];
  if (value === undefined) throw new Error(`The table needs a "${key}" row`);
  return value;
}

// The rows a table may have. page size parameter + page size go together.
async function byPageNumber(client: ApiClient, path: string, options: Options): Promise<unknown[]> {
  const stopWhenFewerThan = number(options, 'stop when fewer than');
  const maxPages = number(options, 'max pages');
  return paginateByPageNumber(client, path, {
    itemsPath: required(options, 'items'),
    ...(options['page size parameter']
      ? {
          pageSize: {
            param: options['page size parameter'],
            size: Number(required(options, 'page size')),
          },
        }
      : {}),
    ...(stopWhenFewerThan !== undefined ? { stopWhenFewerThan } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(options['allow truncation'] === 'true' ? { allowTruncation: true } : {}),
  });
}

async function byCursor(client: ApiClient, path: string, options: Options): Promise<unknown[]> {
  const maxPages = number(options, 'max pages');
  return paginateByCursor(client, path, {
    itemsPath: required(options, 'items'),
    nextCursorPath: required(options, 'next cursor'),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(options['allow truncation'] === 'true' ? { allowTruncation: true } : {}),
  });
}

When(
  'I collect every page of {string} by page number with:',
  async ({ apiClient, vars, attempt }, path: string, table) => {
    attempt.items = await byPageNumber(apiClient, vars.interpolate(path), table.rowsHash());
  },
);

When(
  'I collect every page of {string} by cursor with:',
  async ({ apiClient, vars, attempt }, path: string, table) => {
    attempt.items = await byCursor(apiClient, vars.interpolate(path), table.rowsHash());
  },
);

// Same, when the scenario expects the collection to fail: the error is kept for "the request fails with ...".
When(
  'I try to collect every page of {string} by page number with:',
  async ({ apiClient, vars, attempt }, path: string, table) => {
    attempt.ran = true;
    attempt.error = undefined;
    await byPageNumber(apiClient, vars.interpolate(path), table.rowsHash()).then(
      (items) => (attempt.items = items),
      (error: unknown) =>
        (attempt.error = error instanceof Error ? error : new Error(String(error))),
    );
  },
);

When(
  'I try to collect every page of {string} by cursor with:',
  async ({ apiClient, vars, attempt }, path: string, table) => {
    attempt.ran = true;
    attempt.error = undefined;
    await byCursor(apiClient, vars.interpolate(path), table.rowsHash()).then(
      (items) => (attempt.items = items),
      (error: unknown) =>
        (attempt.error = error instanceof Error ? error : new Error(String(error))),
    );
  },
);

Then('I have collected {int} items', ({ attempt }, count: number) => {
  if (!attempt.items) throw new Error('Nothing was collected yet');
  if (attempt.items.length !== count)
    throw new Error(`Expected ${count} items but collected ${attempt.items.length}`);
});

Then('the collected items are:', ({ attempt, vars }, docString: string) => {
  if (!attempt.items) throw new Error('Nothing was collected yet');
  assert.deepStrictEqual(attempt.items, vars.interpolateDeep(JSON.parse(docString)));
});
