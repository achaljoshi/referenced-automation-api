import { defineConfig } from '@playwright/test';

// A tiny Playwright project used by tests/remoteFixtures.spec.ts, run in a SEPARATE process: REMOTE_INNER picks the
// spec ("on" talks to a stand-in agent started by the spec itself, "off" has the remote host disabled).
export default defineConfig({
  testDir: __dirname,
  testMatch: `${process.env.REMOTE_INNER ?? 'on'}.inner.ts`,
  outputDir: '../../../test-results/remote-project',
  retries: 0,
  workers: 1,
});
