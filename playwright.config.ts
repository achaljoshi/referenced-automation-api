import { defineConfig } from '@playwright/test';
import { loadEnv } from '@automation/referenced-automation-utils';

const env = loadEnv();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: env.getOptional('API_BASE_URL'),
  },
});
