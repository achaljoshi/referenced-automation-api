import { createPlaywrightConfig } from '@automation/referenced-automation-utils';

// Defined once in utils so every repo in the family runs Playwright the same
// way - see createPlaywrightConfig's doc comment for every env var it reads.
export default createPlaywrightConfig({
  dir: __dirname,
  name: '@automation/referenced-automation-api',
  baseUrlKey: 'API_BASE_URL',
});
