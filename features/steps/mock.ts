import * as assert from 'node:assert';
import { createBdd } from 'playwright-bdd';
import { test } from './fixtures';

const { Given, When, Then } = createBdd(test);

// The mock service is this package's MockServer, started for the scenario and stopped after it. The API client is pointed at it.

Given('a mock service is running', ({ mockServer, apiClient }) => {
  apiClient.setBaseUrl(mockServer.baseUrl);
});

// Rows: `body` (JSON), `status`, `delay ms`, and `header <Name>` for each header to send. Only `body` is needed.
Given(
  'the mock service answers {word} {string} with:',
  ({ mockServer, vars }, verb: string, path: string, table) => {
    const rows = table.rowsHash() as Record<string, string>;
    const headers = Object.fromEntries(
      Object.entries(rows)
        .filter(([key]) => key.startsWith('header '))
        .map(([key, value]) => [key.slice('header '.length), vars.interpolate(value)]),
    );
    const options = {
      ...(rows.status !== undefined ? { status: Number(rows.status) } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(rows['delay ms'] !== undefined ? { delayMs: Number(rows['delay ms']) } : {}),
    };
    const body = vars.interpolateDeep(JSON.parse(rows.body ?? 'null'));
    const method = verb.toLowerCase();
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method))
      throw new Error(
        `The mock service cannot answer ${verb}: use GET, POST, PUT, PATCH or DELETE`,
      );
    mockServer[method as 'get'](path, body, options);
  },
);

When('the mock service forgets every mock', ({ mockServer }) => {
  mockServer.reset();
});

// The whole body, not a subset: nothing else may be in it.
Then('the response body is exactly JSON:', ({ apiScenario, vars }, docString: string) => {
  assert.deepStrictEqual(
    apiScenario.response().body(),
    vars.interpolateDeep(JSON.parse(docString)),
  );
});

Then('the response took at least {int} ms', ({ apiScenario }, minMs: number) => {
  const took = apiScenario.response().durationMs;
  if (took < minMs)
    throw new Error(`Expected the response to take at least ${minMs} ms but it took ${took} ms`);
});
