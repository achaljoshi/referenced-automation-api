import { defineConfig } from '@playwright/test';
import { loadEnv } from '@automation/referenced-automation-utils';

const env = loadEnv();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    // Raw results only - generating the viewable HTML report is a separate
    // step (`npm run allure:report`) since it needs a JRE on PATH, unlike
    // collecting results here which is pure JS/TS.
    ['allure-playwright', { resultsDir: 'allure-results' }],
  ],
  use: {
    baseURL: env.getOptional('API_BASE_URL'),
  },
});
