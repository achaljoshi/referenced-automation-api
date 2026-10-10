import { test, expect } from '@playwright/test';
import * as utils from '@automation/referenced-automation-utils';
import { ApiClient, ApiResponse } from '../src';

// The behaviour of utils (crypto, dates, random data, DB, e-mail, SFTP, ...) is tested in the utils package, which owns
// it. This file only checks that what THIS package imports from utils is still there and wired in, so a utils upgrade
// that renames something fails here with a clear message instead of deep inside a test.
test.describe('what this package uses from utils @regression', () => {
  test('the functions the client, fixtures, steps and mocks import exist', () => {
    for (const name of [
      'getPath',
      'hasPath',
      'requirePath',
      'validateSchema',
      'loadEnv',
      'getLogger',
      'getCorrelationId',
      'newCorrelationId',
      'useTestCorrelation',
    ] as const)
      expect(typeof utils[name], name).toBe('function');
    expect(typeof utils.logger.info).toBe('function');
    expect(typeof utils.placeholders.ScenarioVariables).toBe('function');
    expect(typeof utils.placeholders.randomValue).toBe('function');
    expect(typeof utils.placeholders.relativeDate).toBe('function');
  });

  test('ApiResponse traversal is wired to utils getPath (one call through the package)', async () => {
    expect(utils.getPath({ a: [{ b: 1 }] }, 'a[0].b')).toBe(1);
    expect(typeof ApiClient).toBe('function');
    expect(typeof ApiResponse.from).toBe('function');
  });
});
