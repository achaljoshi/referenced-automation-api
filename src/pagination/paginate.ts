import { getPath, getLogger } from '@automation/referenced-automation-utils';
import type { ApiClient } from '../client/apiClient';
import type { ApiResponse } from '../client/apiResponse';
import type { RequestOptions } from '../client/types';

const log = getLogger('api');

/** Every page must be a 2xx: a 401/500 in the middle must fail the call, not end the loop with partial data. */
function expectPageOk(response: ApiResponse, path: string, page: string): void {
  if (!response.ok())
    throw new Error(
      `Pagination of ${path} failed on ${page}: status ${response.status()}\nBody: ${response.text().slice(0, 300)}`,
    );
}

function itemsOf<T>(response: ApiResponse, itemsPath: string, path: string, page: string): T[] {
  const items = getPath<unknown>(response.body(), itemsPath, []);
  if (!Array.isArray(items))
    throw new Error(`Pagination of ${path}: "${itemsPath}" on ${page} is not an array (got ${typeof items})`);
  return items as T[];
}

function capReached(path: string, maxPages: number, allowTruncation: boolean | undefined): void {
  const message = `Pagination of ${path} stopped after maxPages (${maxPages}) with more data still to read`;
  if (!allowTruncation) throw new Error(`${message}. Raise maxPages, or pass allowTruncation: true to accept a partial result.`);
  log.warn(`${message}; returning what was read (allowTruncation)`);
}

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
  /** Safety cap so a misbehaving API can't loop forever. Reaching it with more data left throws unless `allowTruncation`. Default 100. */
  maxPages?: number;
  /** Return what was read, with a warning, when `maxPages` is reached while the API still has more. Default false: that throws. */
  allowTruncation?: boolean;
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

  let finished = false;
  for (let fetched = 0; fetched < maxPages; fetched++) {
    const queryParams: Record<string, string | number> = { [pageParam]: page };
    if (options.pageSize) queryParams[options.pageSize.param] = options.pageSize.size;

    const response = await client.get(path, {
      ...options.requestOptions,
      queryParams: { ...options.requestOptions?.queryParams, ...queryParams },
    });
    const label = `page ${page}`;
    expectPageOk(response, path, label);
    const items = itemsOf<T>(response, options.itemsPath, path, label);
    results.push(...items);

    if (items.length < stopThreshold) {
      finished = true;
      break;
    }
    page += 1;
  }
  if (!finished) capReached(path, maxPages, options.allowTruncation);

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
  /** Return what was read, with a warning, when `maxPages` is reached while the API still has more. Default false: that throws. */
  allowTruncation?: boolean;
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
  const seen = new Set<string>();
  let finished = false;

  for (let fetched = 0; fetched < maxPages; fetched++) {
    const queryParams = cursor !== undefined ? { [cursorParam]: cursor } : undefined;
    const response = await client.get(path, {
      ...options.requestOptions,
      queryParams: { ...options.requestOptions?.queryParams, ...queryParams },
    });

    const label = `page ${fetched + 1}${cursor !== undefined ? ` (cursor ${JSON.stringify(cursor)})` : ''}`;
    expectPageOk(response, path, label);
    const items = itemsOf<T>(response, options.itemsPath, path, label);
    results.push(...items);

    const next = getPath<string | number | null | undefined>(
      response.body(),
      options.nextCursorPath,
      undefined,
    );
    // no cursor, or an empty one, is how an API says "that was the last page"
    if (next === undefined || next === null || next === '') {
      finished = true;
      break;
    }
    if (seen.has(String(next)))
      throw new Error(
        `Pagination of ${path}: the cursor ${JSON.stringify(next)} came back again on ${label} - the API is looping`,
      );
    seen.add(String(next));
    cursor = next;
  }
  if (!finished) capReached(path, maxPages, options.allowTruncation);

  return results;
}
