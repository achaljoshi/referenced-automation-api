import { defineConfig } from '@playwright/test';

// A tiny Playwright project used by tests/apiFixtures.spec.ts: its own folder holds the .env.qa file, and the test
// runs with a DIFFERENT working directory, to prove the apiClient fixture reads the env files next to the config.
export default defineConfig({
  testDir: __dirname,
  testMatch: '*.inner.ts',
  outputDir: '../../../test-results/env-project',
  retries: 0,
  workers: 1,
});
