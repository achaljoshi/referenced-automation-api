import { getPath } from '@automation/referenced-automation-utils';
import type { ApiClient } from '../client/apiClient';
import type { RequestOptions } from '../client/types';

export interface PageNumberPaginationOptions {
  /** Query param name for the page number/index, e.g. 'page'. */
  pageParam?: string;
  /** First page's value - some APIs start at 0, most at 1. */
  startPage?: number;
  /** Optional page-size query param, e.g. { param: 'pageSize', size: 50 }. */
  pageSize?: { param: string; size: number };
  /** Dot/bracket path to the array of items in each page's response body. */
  itemsPath: string;
  /** Stop once a page returns fewer items than this (defaults to 1, i.e. stop on empty). */
  stopWhenFewerThan?: number;
  /** Safety cap so a misbehaving API can't loop forever. Default 100. */
  maxPages?: number;
  requestOptions?: RequestOptions;
}

/** Page-number-based pagination: keeps requesting ?page=1, ?page=2, ... until a short/empty page. */
export async function paginateByPageNumber<T = unknown>(
  client: ApiClient,
  path: string,
  options: PageNumberPaginationOptions,
): Promise<T[]> {
  const pageParam = options.pageParam ?? 'page';
  const maxPages = options.maxPages ?? 100;
  const stopThreshold = options.stopWhenFewerThan ?? 1;

  const results: T[] = [];
  let page = options.startPage ?? 1;

  for (let fetched = 0; fetched < maxPages; fetched++) {
    const queryParams: Record<string, string | number> = { [pageParam]: page };
    if (options.pageSize) queryParams[options.pageSize.param] = options.pageSize.size;

    const response = await client.get(path, {
      ...options.requestOptions,
      queryParams: { ...options.requestOptions?.queryParams, ...queryParams },
    });
    const items = getPath<T[]>(response.body(), options.itemsPath, []);
    results.push(...items);

    if (items.length < stopThreshold) break;
    page += 1;
  }

  return results;
}

export interface CursorPaginationOptions {
  /** Dot/bracket path to the array of items in each page's response body. */
  itemsPath: string;
  /** Dot/bracket path to the next cursor value in each page's response body. */
  nextCursorPath: string;
  /** Query param name the cursor is sent under, e.g. 'cursor' or 'after'. */
  cursorParam?: string;
  maxPages?: number;
  requestOptions?: RequestOptions;
}

/** Cursor-based pagination: follows the `next`-style cursor a response reports until there isn't one. */
export async function paginateByCursor<T = unknown>(
  client: ApiClient,
  path: string,
  options: CursorPaginationOptions,
): Promise<T[]> {
  const cursorParam = options.cursorParam ?? 'cursor';
  const maxPages = options.maxPages ?? 100;

  const results: T[] = [];
  let cursor: string | number | undefined;

  for (let fetched = 0; fetched < maxPages; fetched++) {
    const queryParams = cursor !== undefined ? { [cursorParam]: cursor } : undefined;
    const response = await client.get(path, {
      ...options.requestOptions,
      queryParams: { ...options.requestOptions?.queryParams, ...queryParams },
    });

    const items = getPath<T[]>(response.body(), options.itemsPath, []);
    results.push(...items);

    const next = getPath<string | number | null | undefined>(
      response.body(),
      options.nextCursorPath,
      undefined,
    );
    if (next === undefined || next === null) break;
    cursor = next;
  }

  return results;
}
