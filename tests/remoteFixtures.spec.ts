import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runPlaywright } from './support/runPlaywright';

// API_VIA_REMOTE and the remote fixtures are env-driven, so they are proved in a SEPARATE Playwright process on a tiny
// project (tests/support/remoteProject). Remote side: the stand-in agent only - never a real RDP host.
const project = path.join(__dirname, 'support', 'remoteProject');
const config = path.join(project, 'playwright.config.ts');

const REMOTE_OFF: Record<string, string | undefined> = {
  REMOTE_ENABLED: undefined,
  API_VIA_REMOTE: undefined,
  REMOTE_API_BASE_URL: undefined,
  API_BASE_URL: 'http://local-side.test',
};

function onEnv(shareDir: string, extra: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...REMOTE_OFF,
    REMOTE_ENABLED: 'true',
    REMOTE_RDP_HOST: 'rdp-host.test',
    REMOTE_AGENT_START: 'manual',
    REMOTE_SHARE_DIR: shareDir,
    REMOTE_POLL_MS: '20',
    REMOTE_HEARTBEAT_MS: '100',
    REMOTE_HEARTBEAT_STALE_MS: '1000',
    REMOTE_CONNECT_TIMEOUT_MS: '5000',
    REMOTE_REQUEST_TIMEOUT_MS: '5000',
    REMOTE_INNER: 'on',
    ...extra,
  };
}

test.describe('API_VIA_REMOTE and the remote fixtures, in a separate Playwright run @regression', () => {
  test('API_VIA_REMOTE=true switches apiClient and apiFor to the remote host; REMOTE_API_BASE_URL is the remoteApiClient base', () => {
    const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-remote-inner-'));
    const run = runPlaywright(config, {
      cwd: os.tmpdir(),
      env: onEnv(shareDir, {
        API_VIA_REMOTE: 'true',
        REMOTE_API_BASE_URL: 'http://remote-side.test/api',
        API_BASE_URL: 'http://local-side.test',
        EXPECT_BASE: 'http://remote-side.test/api',
      }),
    });
    expect({ passed: run.passed, failed: run.failed }, run.summary).toEqual({ passed: 5, failed: 0 });
  });

  test('without REMOTE_API_BASE_URL the remoteApiClient uses API_BASE_URL', () => {
    const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-remote-inner-'));
    const run = runPlaywright(config, {
      cwd: os.tmpdir(),
      env: onEnv(shareDir, { API_BASE_URL: 'http://fallback.test', EXPECT_BASE: 'http://fallback.test' }),
    });
    // API_VIA_REMOTE is off here: the three switch tests skip, the two remote-fixture tests run
    expect({ passed: run.passed, failed: run.failed, skipped: run.skipped }, run.summary).toEqual({ passed: 2, failed: 0, skipped: 3 });
  });

  test('remoteApiClient fails clearly when REMOTE_ENABLED is off', () => {
    const run = runPlaywright(config, {
      cwd: os.tmpdir(),
      env: { ...REMOTE_OFF, REMOTE_INNER: 'off' },
    });
    // the plain apiClient is untouched (passes); the remote client fails and says what to set
    expect({ passed: run.passed, failed: run.failed }, run.summary).toEqual({ passed: 1, failed: 1 });
    expect(run.summary).toMatch(/remoteApiClient needs the remote desktop host, but REMOTE_ENABLED is not true\. Set the REMOTE_\* keys/);
  });

  test('API_VIA_REMOTE=true with the remote host disabled fails the apiClient fixture with the same message', () => {
    const run = runPlaywright(config, {
      cwd: os.tmpdir(),
      env: { ...REMOTE_OFF, API_VIA_REMOTE: 'true', REMOTE_INNER: 'off' },
    });
    expect({ passed: run.passed, failed: run.failed }, run.summary).toEqual({ passed: 0, failed: 2 });
    expect(run.summary).toMatch(/API_VIA_REMOTE=true needs the remote desktop host, but REMOTE_ENABLED is not true/);
  });
});
