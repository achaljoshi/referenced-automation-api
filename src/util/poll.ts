export interface PollOptions {
  /** Give up after this long. Default 30 s. */
  timeoutMs?: number;
  /** Waits between tries; the last one repeats. Default 250, 500, 1000, 2000 ms. */
  intervalsMs?: number[];
  /** Names what was being waited for, so the timeout error says it. */
  description?: string;
}

export class PollTimeoutError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly last: unknown,
  ) {
    super(message);
    this.name = 'PollTimeoutError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tries `attempt` until `done(result)` is true, for the things an API does in the background - a job that finishes,
 * an order that moves to SHIPPED, a record that shows up in the search index. Returns the result that satisfied
 * `done`. On timeout it throws a PollTimeoutError carrying the last result, so the failure shows what the system
 * said last rather than just "timed out".
 */
export async function pollUntil<T>(
  attempt: () => Promise<T>,
  done: (value: T) => boolean | Promise<boolean>,
  options: PollOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervals =
    options.intervalsMs && options.intervalsMs.length > 0
      ? options.intervalsMs
      : [250, 500, 1000, 2000];
  const startedAt = Date.now();
  let attempts = 0;
  let last: T | undefined;
  for (;;) {
    attempts += 1;
    last = await attempt();
    if (await done(last)) return last;
    const wait = intervals[Math.min(attempts - 1, intervals.length - 1)] as number;
    if (Date.now() - startedAt + wait > timeoutMs) {
      throw new PollTimeoutError(
        `Gave up waiting${options.description ? ` for ${options.description}` : ''} after ${attempts} attempt(s) and ${Date.now() - startedAt}ms (limit ${timeoutMs}ms). Last result: ${summarize(last)}`,
        attempts,
        last,
      );
    }
    await sleep(wait);
  }
}

function summarize(value: unknown): string {
  const status = (value as { status?: () => number } | undefined)?.status;
  const text = (value as { text?: () => string } | undefined)?.text;
  if (typeof status === 'function' && typeof text === 'function')
    return `${status.call(value)} ${text.call(value).slice(0, 300)}`;
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Runs `worker` over `items` with at most `limit` in flight at once, returning results in input order - bulk setup without hammering the API. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export { sleep };
