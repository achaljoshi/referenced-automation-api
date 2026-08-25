import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startTestServer, stopTestServer, type TestServerHandle } from '../support/testServer';
import { recordApiTraffic, playApiRecording } from '../../src/mock/recorder';

const recordingFile = path.join(__dirname, '..', '..', 'test-results', 'tmp-recorded-users.json');

test.afterEach(async () => {
  await fs.promises.rm(recordingFile, { force: true });
});

test.describe('recordApiTraffic / playApiRecording @regression', () => {
  test('records a real response, then replays it after the real server is gone', async ({ page }) => {
    let server: TestServerHandle | undefined;
    try {
      server = await startTestServer();
      const usersUrl = `${server.baseUrl}/users`;

      const handle = await recordApiTraffic(page, usersUrl, recordingFile);
      await page.goto(usersUrl);
      const liveText = await page.locator('body').innerText();
      expect(liveText).toContain('Ada Lovelace');
      await handle.save();

      const recording = JSON.parse(await fs.promises.readFile(recordingFile, 'utf-8'));
      expect(recording.entries).toHaveLength(1);
      expect(recording.entries[0]).toEqual(
        expect.objectContaining({ method: 'GET', url: usersUrl, status: 200 }),
      );

      // Prove replay doesn't need the real backend at all - stop it first.
      await stopTestServer(server);
      server = undefined;

      await playApiRecording(page, recordingFile, usersUrl);
      const replayedResponse = await page.goto(usersUrl);
      expect(replayedResponse?.status()).toBe(200);
      const replayedText = await page.locator('body').innerText();
      expect(replayedText).toBe(liveText);
    } finally {
      if (server) await stopTestServer(server);
    }
  });

  test('an unmatched request inside the pattern falls through by default', async ({ page }) => {
    let server: TestServerHandle | undefined;
    try {
      server = await startTestServer();
      const usersUrl = `${server.baseUrl}/users`;

      const handle = await recordApiTraffic(page, usersUrl, recordingFile);
      await page.goto(usersUrl);
      await handle.save();

      // Replay against a *different* path under the same server, matched by
      // a pattern broad enough to intercept it but with no recorded entry
      // for it - it should fall through to the still-live real server.
      await playApiRecording(page, recordingFile, `${server.baseUrl}/**`);
      const response = await page.goto(`${server.baseUrl}/users/1`);
      expect(response?.status()).toBe(200);
      const text = await page.locator('body').innerText();
      expect(JSON.parse(text)).toEqual(expect.objectContaining({ id: 1, name: 'Ada Lovelace' }));
    } finally {
      if (server) await stopTestServer(server);
    }
  });
});
