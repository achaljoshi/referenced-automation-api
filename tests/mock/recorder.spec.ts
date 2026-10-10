import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import { startTestServer, stopTestServer, type TestServerHandle } from '../support/testServer';
import { recordApiTraffic, playApiRecording, type ApiRecording } from '../../src/mock/recorder';

// Each test writes to ITS OWN folder (testInfo.outputPath): tests run in parallel, and one shared file made them
// overwrite and delete each other's recordings.
const readRecording = async (file: string) =>
  JSON.parse(await fs.promises.readFile(file, 'utf-8')) as ApiRecording;

test.describe('recordApiTraffic / playApiRecording @regression', () => {
  test('records a real response, then replays it after the real server is gone', async ({ page }, testInfo) => {
    const recordingFile = testInfo.outputPath('recorded-users.json');
    let server: TestServerHandle | undefined;
    try {
      server = await startTestServer();
      const usersUrl = `${server.baseUrl}/users`;

      const handle = await recordApiTraffic(page, usersUrl, recordingFile);
      await page.goto(usersUrl);
      const liveText = await page.locator('body').innerText();
      expect(liveText).toContain('Ada Lovelace');
      await handle.save();

      const recording = await readRecording(recordingFile);
      expect(recording.entries).toHaveLength(1);
      expect(recording.entries[0]).toEqual(
        expect.objectContaining({ method: 'GET', url: usersUrl, status: 200 }),
      );

      // Prove replay doesn't need the real backend at all - stop it first.
      await stopTestServer(server);
      server = undefined;

      const replay = await playApiRecording(page, recordingFile, usersUrl);
      const replayedResponse = await page.goto(usersUrl);
      expect(replayedResponse?.status()).toBe(200);
      const replayedText = await page.locator('body').innerText();
      expect(replayedText).toBe(liveText);
      expect(replay.unmatched).toEqual([]);
    } finally {
      if (server) await stopTestServer(server);
    }
  });

  test('an unmatched request inside the pattern FAILS by default and never reaches the live server', async ({ page }, testInfo) => {
    const recordingFile = testInfo.outputPath('recorded-users.json');
    const server = await startTestServer();
    try {
      const usersUrl = `${server.baseUrl}/users`;
      const handle = await recordApiTraffic(page, usersUrl, recordingFile);
      await page.goto(usersUrl);
      await handle.save();

      // A pattern broad enough to intercept /users/1, with no recorded entry for it.
      const replay = await playApiRecording(page, recordingFile, `${server.baseUrl}/**`);
      const before = server.requests.length;
      await expect(page.goto(`${server.baseUrl}/users/1`)).rejects.toThrow(/ERR_FAILED/);
      expect(server.requests.slice(before)).toEqual([]); // the live server was not asked
      expect(replay.unmatched).toEqual([`GET ${server.baseUrl}/users/1`]);
    } finally {
      await stopTestServer(server);
    }
  });

  test("onMiss: 'continue' sends an unmatched request to the real network (the old default, now opt-in)", async ({ page }, testInfo) => {
    const recordingFile = testInfo.outputPath('recorded-users.json');
    const server = await startTestServer();
    try {
      const usersUrl = `${server.baseUrl}/users`;
      const handle = await recordApiTraffic(page, usersUrl, recordingFile);
      await page.goto(usersUrl);
      await handle.save();

      await playApiRecording(page, recordingFile, `${server.baseUrl}/**`, { onMiss: 'continue' });
      const response = await page.goto(`${server.baseUrl}/users/1`);
      expect(response?.status()).toBe(200);
      expect(JSON.parse(await page.locator('body').innerText())).toEqual(
        expect.objectContaining({ id: 1, name: 'Ada Lovelace' }),
      );
    } finally {
      await stopTestServer(server);
    }
  });

  test('credentials are redacted when the traffic is RECORDED: nothing secret is in the file', async ({ page }, testInfo) => {
    const recordingFile = testInfo.outputPath('recorded-secrets.json');
    const server = await startTestServer();
    try {
      const url = `${server.baseUrl}/me-secrets?access_token=live-query-token&page=1`;
      const handle = await recordApiTraffic(page, `${server.baseUrl}/me-secrets*`, recordingFile);
      await page.goto(url);
      expect(await page.locator('body').innerText()).toContain('hunter2-live'); // the live page saw the real thing
      await handle.save();

      const text = await fs.promises.readFile(recordingFile, 'utf-8');
      for (const secret of ['hunter2-live', 'live-access-token', 'live-api-key-value', 'live-session-cookie', 'live-query-token'])
        expect(text, secret).not.toContain(secret);
      const [entry] = (await readRecording(recordingFile)).entries;
      expect(entry?.headers['set-cookie']).toBeUndefined();
      expect(entry?.headers['x-api-key']).toBe('[REDACTED]');
      expect(entry?.url).toContain('access_token=[REDACTED]');
      const body = JSON.parse(Buffer.from(entry?.body ?? '', 'base64').toString()) as Record<string, unknown>;
      expect(body).toMatchObject({ name: 'Ada', password: '[REDACTED]', access_token: '[REDACTED]' });

      // A replay with a DIFFERENT token still finds the entry: both sides are compared masked
      await stopTestServer(server);
      const replay = await playApiRecording(page, recordingFile, `${server.baseUrl}/me-secrets*`);
      const replayed = await page.goto(`${server.baseUrl}/me-secrets?access_token=another-token&page=1`);
      expect(replayed?.status()).toBe(200);
      expect(replay.unmatched).toEqual([]);
    } finally {
      await stopTestServer(server).catch(() => undefined);
    }
  });

  test('ignoreQueryParams: a volatile parameter does not stop a replay from matching', async ({ page }, testInfo) => {
    const recordingFile = testInfo.outputPath('recorded-search.json');
    const server = await startTestServer();
    try {
      const handle = await recordApiTraffic(page, `${server.baseUrl}/search*`, recordingFile);
      await page.goto(`${server.baseUrl}/search?q=ada&_=111`);
      await handle.save();

      const strict = await playApiRecording(page, recordingFile, `${server.baseUrl}/search*`);
      await expect(page.goto(`${server.baseUrl}/search?q=ada&_=222`)).rejects.toThrow(/ERR_FAILED/);
      expect(strict.unmatched).toHaveLength(1);

      await page.unroute(`${server.baseUrl}/search*`);
      const lenient = await playApiRecording(page, recordingFile, `${server.baseUrl}/search*`, {
        ignoreQueryParams: ['_', /^ts/],
      });
      const response = await page.goto(`${server.baseUrl}/search?q=ada&_=333&ts1=9`);
      expect(response?.status()).toBe(200);
      expect(lenient.unmatched).toEqual([]);
    } finally {
      await stopTestServer(server);
    }
  });
});
