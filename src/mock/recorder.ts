import type { Page, Request as PlaywrightRequest } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@automation/referenced-automation-utils';

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
 * every request/response pair is captured as it happens. Call `save()` once
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
    entries.push({
      method: request.method(),
      url: request.url(),
      status: response.status(),
      headers,
      contentType: headers['content-type'] ?? 'application/octet-stream',
      body: bodyBuffer.toString('base64'),
      requestBody: request.postData(),
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
  /** Called for a request inside urlPattern with no matching recorded entry - defaults to route.fallback(). */
  onUnmatched?: (request: PlaywrightRequest) => Promise<void>;
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
): Promise<void> {
  const raw = await fs.promises.readFile(inputFile, 'utf-8');
  const recording = JSON.parse(raw) as ApiRecording;
  const matchBy = options.matchBy ?? 'method+url';

  await page.route(urlPattern, async (route, request) => {
    const entry = recording.entries.find((candidate) => {
      if (candidate.url !== request.url()) return false;
      return matchBy === 'url' || candidate.method === request.method();
    });

    if (!entry) {
      logger.warn(`[playApiRecording] no recorded entry for ${request.method()} ${request.url()}`);
      if (options.onUnmatched) {
        await options.onUnmatched(request);
      } else {
        await route.fallback();
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
}
