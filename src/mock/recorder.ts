import type { Page, Request as PlaywrightRequest } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@automation/referenced-automation-utils';
import { isCredentialHeader, redactBody, REDACTED } from '../client/exchange';
import { safeUrl } from '../client/logging';

const TEXT_TYPE = /json|xml|x-www-form-urlencoded|^text\//i;

/**
 * Headers as they are stored: credentials masked, Set-Cookie dropped (a replayed page has no use for a session cookie),
 * and Content-Length / Content-Encoding dropped (the body is stored decoded and possibly masked, so they would be wrong).
 */
function recordedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !['set-cookie', 'content-length', 'content-encoding'].includes(name.toLowerCase()))
      .map(([name, value]) => [name, isCredentialHeader(name) ? REDACTED : value]),
  );
}

/** A response body as it is stored (base64): text bodies (JSON, XML, forms) have password/token fields masked, others are kept byte for byte. */
function recordedBody(body: Buffer, contentType: string): string {
  if (!TEXT_TYPE.test(contentType)) return body.toString('base64');
  return Buffer.from(redactBody(body.toString('utf8'), contentType) ?? '', 'utf8').toString('base64');
}

/**
 * A URL as recordings compare it: credentials in the query and token-like path segments masked (the same masking the
 * recorder stores), and any query parameter in `ignore` removed - so a recording made with one token or timestamp
 * still matches a replay made with another.
 */
function matchUrl(url: string, ignore: Array<string | RegExp> = []): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()])
      if (ignore.some((rule) => (typeof rule === 'string' ? rule === key : rule.test(key))))
        parsed.searchParams.delete(key);
    return safeUrl(parsed.toString());
  } catch {
    return url;
  }
}

export interface RecordedApiEntry {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  /** Base64-encoded response body, so binary responses (images, gzip, ...) round-trip safely. */
  body: string;
  requestBody: string | null;
  recordedAt: string;
}

export interface ApiRecording {
  entries: RecordedApiEntry[];
}

export interface RecordApiTrafficHandle {
  /** Stops intercepting and writes every recorded entry to disk as one script file. */
  save(): Promise<void>;
}

/**
 * Records real API traffic matching `urlPattern` while letting it reach the
 * real network unchanged (`route.fetch()` performs the actual request, then
 * fulfills from its real response) - the test observes real behaviour, but
 * every request/response pair is captured as it happens. Credentials are masked AS IT IS RECORDED (Authorization,
 * Cookie and similar headers, Set-Cookie dropped, password/token fields in text bodies, token-like URL parts), so the
 * file is safe to commit - and a replay of a login gets the masked value back. Call `save()` once
 * the interesting traffic has occurred to write it to `outputFile`; feed
 * that file to `playApiRecording()` afterwards to replay the same session
 * with no live backend at all.
 */
export async function recordApiTraffic(
  page: Page,
  urlPattern: string | RegExp,
  outputFile: string,
): Promise<RecordApiTrafficHandle> {
  const entries: RecordedApiEntry[] = [];

  await page.route(urlPattern, async (route, request) => {
    const response = await route.fetch();
    const bodyBuffer = await response.body();
    const headers = response.headers();
    const contentType = headers['content-type'] ?? 'application/octet-stream';
    const requestBody = request.postData();
    entries.push({
      method: request.method(),
      url: matchUrl(request.url()),
      status: response.status(),
      headers: recordedHeaders(headers),
      contentType,
      body: recordedBody(bodyBuffer, contentType),
      requestBody:
        requestBody === null
          ? null
          : redactBody(requestBody, request.headers()['content-type']) ?? null,
      recordedAt: new Date().toISOString(),
    });
    await route.fulfill({ response, body: bodyBuffer });
  });

  return {
    async save() {
      await page.unroute(urlPattern);
      await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
      const recording: ApiRecording = { entries };
      await fs.promises.writeFile(outputFile, JSON.stringify(recording, null, 2));
      logger.info(`[recordApiTraffic] wrote ${entries.length} entries to ${outputFile}`);
    },
  };
}

export interface PlayApiRecordingOptions {
  /**
   * How an incoming request is matched against the recording:
   * - `'method+url'` (default): exact method + exact URL, including query string.
   * - `'url'`: method is ignored, only the URL must match.
   */
  matchBy?: 'method+url' | 'url';
  /** Query parameters left out of the comparison, by name or pattern - for values that change on every run (`_`, `timestamp`, `nonce`, a token). */
  ignoreQueryParams?: Array<string | RegExp>;
  /**
   * What happens to a request inside urlPattern with no matching recorded entry:
   * - `'fail'` (default): it is refused (the page sees a network error), logged as an error and listed in the returned
   *   handle's `unmatched` - it never reaches the live network, so a replay cannot quietly depend on a real backend.
   * - `'continue'`: it goes to the real network (`route.fallback()`).
   */
  onMiss?: 'fail' | 'continue';
  /** Called instead of `onMiss` for a request with no matching recorded entry. */
  onUnmatched?: (request: PlaywrightRequest) => Promise<void>;
}

export interface PlayApiRecordingHandle {
  /** `METHOD url` of every request that matched the pattern but had no recorded entry (and was refused, with `onMiss: 'fail'`). Assert it is empty at the end of a test. */
  readonly unmatched: string[];
}

/**
 * Replays a recording produced by `recordApiTraffic()`: intercepts requests
 * matching `urlPattern` and fulfills them from the saved script instead of
 * touching the network - deterministic, offline playback of a real session,
 * no backend (or even network access) required at all.
 */
export async function playApiRecording(
  page: Page,
  inputFile: string,
  urlPattern: string | RegExp,
  options: PlayApiRecordingOptions = {},
): Promise<PlayApiRecordingHandle> {
  const raw = await fs.promises.readFile(inputFile, 'utf-8');
  const recording = JSON.parse(raw) as ApiRecording;
  const matchBy = options.matchBy ?? 'method+url';
  const onMiss = options.onMiss ?? 'fail';
  const unmatched: string[] = [];

  await page.route(urlPattern, async (route, request) => {
    const wanted = matchUrl(request.url(), options.ignoreQueryParams);
    const entry = recording.entries.find((candidate) => {
      if (matchUrl(candidate.url, options.ignoreQueryParams) !== wanted) return false;
      return matchBy === 'url' || candidate.method === request.method();
    });

    if (!entry) {
      const what = `${request.method()} ${safeUrl(request.url())}`;
      if (options.onUnmatched) {
        logger.warn(`[playApiRecording] no recorded entry for ${what}`);
        await options.onUnmatched(request);
      } else if (onMiss === 'continue') {
        logger.warn(`[playApiRecording] no recorded entry for ${what} - sending it to the network`);
        await route.fallback();
      } else {
        unmatched.push(what);
        logger.error(`[playApiRecording] no recorded entry for ${what} - refused`);
        await route.abort('failed');
      }
      return;
    }

    await route.fulfill({
      status: entry.status,
      contentType: entry.contentType,
      headers: entry.headers,
      body: Buffer.from(entry.body, 'base64'),
    });
  });
  return { unmatched };
}
