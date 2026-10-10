import { createPlaywrightConfig } from '@automation/referenced-automation-utils';
import { defineBddConfig } from 'playwright-bdd';

// Defined once in utils so every repo in the family runs Playwright the same
// way - see createPlaywrightConfig's doc comment for every env var it reads.
// Gherkin features: `bddgen` turns features/*.feature + features/steps/*.ts into runnable tests in .features-gen/
// (the npm scripts run it first). They are their own project, so `--project=bdd` runs only them.
const bddTestDir = defineBddConfig({
  features: 'features/*.feature',
  steps: 'features/steps/*.ts',
  outputDir: '.features-gen',
});

export default createPlaywrightConfig({
  dir: __dirname,
  name: '@automation/referenced-automation-api',
  baseUrlKey: 'API_BASE_URL',
  extraProjects: [{ name: 'bdd', testDir: bddTestDir }],
});
