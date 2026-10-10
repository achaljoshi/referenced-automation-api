import * as path from 'node:path';
import { test as playwrightTest, type TestInfo } from '@playwright/test';

/**
 * The directory of the Playwright config the running test belongs to - where `.env.<ENV>` lives - so the IDE, the CLI
 * and CI read the same files whatever directory they were started from. `undefined` outside a test (callers then fall
 * back to the working directory, which is what `loadEnv()` does on its own).
 */
export function projectDir(info?: TestInfo): string | undefined {
  try {
    const testInfo = info ?? playwrightTest.info();
    return testInfo.config.configFile ? path.dirname(testInfo.config.configFile) : testInfo.config.rootDir;
  } catch {
    return undefined;
  }
}
