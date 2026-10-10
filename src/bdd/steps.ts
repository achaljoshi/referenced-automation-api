import * as fs from 'node:fs';
import { placeholders } from '@automation/referenced-automation-utils';
import { ApiKeyAuth, BasicAuth, BearerAuth } from '../auth/authProvider';
import type { ApiClient } from '../client/apiClient';
import type { ApiResponse } from '../client/apiResponse';
import type { HttpMethod, RequestOptions } from '../client/types';
import { subsetDifferences } from '../client/subset';
import type { ApiScenario } from './scenario';
import type { BddSteps, TableLike } from './types';

type Vars = placeholders.ScenarioVariables;

/** What the steps need from the test: see ../fixtures/apiFixtures (`apiClient`, `vars`, `apiScenario`). */
interface ApiStepFixtures {
  apiClient: ApiClient;
  vars: Vars;
  apiScenario: ApiScenario;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function method(word: string): HttpMethod {
  const upper = word.toUpperCase();
  if (!METHODS.includes(upper))
    throw new Error(
      `"${word}" is not an HTTP method the client can send. Use one of: ${METHODS.join(', ')}`,
    );
  return upper as HttpMethod;
}

/** The text of a response field, the way a feature file writes it: strings as they are, everything else as JSON. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function table(data: TableLike, vars: Vars): Record<string, string> {
  return Object.fromEntries(
    Object.entries(data.rowsHash()).map(([key, value]) => [key, vars.interpolate(value)]),
  );
}

async function send(
  { apiClient, vars, apiScenario }: ApiStepFixtures,
  verb: string,
  path: string,
  extra: RequestOptions = {},
): Promise<ApiResponse> {
  const query = { ...apiScenario.pendingQuery, ...extra.queryParams };
  apiScenario.pendingQuery = {};
  const response = await apiClient.request(method(verb), vars.interpolate(path), {
    ...extra,
    ...(Object.keys(query).length > 0 ? { queryParams: query } : {}),
  });
  apiScenario.lastResponse = response;
  return response;
}

/**
 * Business-readable steps for features that call an API. Library-agnostic: pass the Given/When/Then of your BDD tool
 * (playwright-bdd's `createBdd(test)` gives them). The test they run in needs the `apiClient`, `vars` and
 * `apiScenario` fixtures - this package's `test` has them.
 *
 *   Given I am authenticated with the bearer token "{{env:API_TOKEN}}"
 *   When I send a POST request to "/users" with JSON:
 *     """
 *     { "name": "{{random:first-name}}" }
 *     """
 *   Then the response status is 201
 *   And the response field "name" is not empty
 *   And I remember the response field "id" as "userId"
 *   When I send a GET request to "/users/{{userId}}"
 *   Then the response field "id" equals "{{userId}}"
 *
 * Every string, docstring and table cell goes through {{placeholders}}: saved values, {{env:X}}, {{uuid}},
 * {{random:email}}, {{date:+7d}}. Pair with `registerDataSteps` for the steps that make and check those values.
 */
export function registerApiSteps({ Given, When, Then }: BddSteps): void {
  // ---- Given: how requests are made ----

  Given('the API base URL is {string}', ({ apiClient, vars }: ApiStepFixtures, url: string) => {
    apiClient.setBaseUrl(vars.interpolate(url));
  });

  Given(
    'I set the header {string} to {string}',
    ({ apiClient, vars }: ApiStepFixtures, name: string, value: string) => {
      apiClient.setHeader(name, vars.interpolate(value));
    },
  );

  Given('I set the headers:', ({ apiClient, vars }: ApiStepFixtures, data: TableLike) => {
    apiClient.setHeaders(table(data, vars));
  });

  Given(
    'I set the query parameter {string} to {string}',
    ({ apiScenario, vars }: ApiStepFixtures, name: string, value: string) => {
      apiScenario.pendingQuery[name] = vars.interpolate(value);
    },
  );

  Given(
    'I am authenticated with the bearer token {string}',
    ({ apiClient, vars }: ApiStepFixtures, token: string) => {
      apiClient.setAuth(new BearerAuth(vars.interpolate(token)));
    },
  );

  Given(
    'I am authenticated as {string} with the password {string}',
    ({ apiClient, vars }: ApiStepFixtures, user: string, password: string) => {
      apiClient.setAuth(new BasicAuth(vars.interpolate(user), vars.interpolate(password)));
    },
  );

  Given(
    'I use the API key {string} in the header {string}',
    ({ apiClient, vars }: ApiStepFixtures, key: string, header: string) => {
      apiClient.setAuth(new ApiKeyAuth(header, vars.interpolate(key)));
    },
  );

  Given('I am not authenticated', ({ apiClient }: ApiStepFixtures) => {
    apiClient.clearAuth();
  });

  Given(
    'I retry throttled and unavailable responses up to {int} times',
    ({ apiClient }: ApiStepFixtures, times: number) => {
      apiClient.setRetryPolicy({ attempts: times + 1, backoffMs: 100 });
    },
  );

  // ---- When: sending ----

  When(
    'I send a {word} request to {string}',
    async ({ apiClient, vars, apiScenario }: ApiStepFixtures, verb: string, path: string) => {
      await send({ apiClient, vars, apiScenario }, verb, path);
    },
  );

  When(
    'I send a {word} request to {string} with JSON:',
    async (
      { apiClient, vars, apiScenario }: ApiStepFixtures,
      verb: string,
      path: string,
      docString: string,
    ) => {
      await send({ apiClient, vars, apiScenario }, verb, path, {
        json: vars.interpolateDeep(JSON.parse(docString)),
      });
    },
  );

  When(
    'I send a {word} request to {string} with XML:',
    async (
      { apiClient, vars, apiScenario }: ApiStepFixtures,
      verb: string,
      path: string,
      docString: string,
    ) => {
      await send({ apiClient, vars, apiScenario }, verb, path, {
        xml: vars.interpolate(docString),
      });
    },
  );

  When(
    'I send a {word} request to {string} with form data:',
    async (
      { apiClient, vars, apiScenario }: ApiStepFixtures,
      verb: string,
      path: string,
      data: TableLike,
    ) => {
      await send({ apiClient, vars, apiScenario }, verb, path, { form: table(data, vars) });
    },
  );

  When(
    'I send a {word} request to {string} with query parameters:',
    async (
      { apiClient, vars, apiScenario }: ApiStepFixtures,
      verb: string,
      path: string,
      data: TableLike,
    ) => {
      await send({ apiClient, vars, apiScenario }, verb, path, { queryParams: table(data, vars) });
    },
  );

  When(
    'I send a {word} request to {string} with the raw body {string}',
    async (
      { apiClient, vars, apiScenario }: ApiStepFixtures,
      verb: string,
      path: string,
      body: string,
    ) => {
      await send({ apiClient, vars, apiScenario }, verb, path, { rawBody: vars.interpolate(body) });
    },
  );

  When(
    'I upload the file {string} as {string} to {string}',
    async (
      { apiClient, vars, apiScenario }: ApiStepFixtures,
      file: string,
      field: string,
      path: string,
    ) => {
      await send({ apiClient, vars, apiScenario }, 'POST', path, {
        multipart: { [field]: { filePath: vars.interpolate(file) } },
      });
    },
  );

  When(
    'I send the GraphQL query:',
    async ({ apiClient, vars, apiScenario }: ApiStepFixtures, docString: string) => {
      apiScenario.lastResponse = await apiClient.graphql(vars.interpolate(docString));
    },
  );

  When(
    'I download {string} to {string}',
    async ({ apiClient, vars }: ApiStepFixtures, path: string, file: string) => {
      await apiClient.download(vars.interpolate(path), { saveTo: vars.interpolate(file) });
    },
  );

  When(
    'I wait until a {word} request to {string} returns {string} equal to {string} within {int} seconds',
    async (
      { apiClient, vars, apiScenario }: ApiStepFixtures,
      verb: string,
      path: string,
      field: string,
      expected: string,
      seconds: number,
    ) => {
      apiScenario.lastResponse = await apiClient.poll(method(verb), vars.interpolate(path), {
        until: (response) => asText(response.get(field)) === vars.interpolate(expected),
        timeoutMs: seconds * 1000,
        description: `"${field}" to equal "${expected}"`,
      });
    },
  );

  // ---- Then: the response ----

  Then('the response status is {int}', ({ apiScenario }: ApiStepFixtures, status: number) => {
    apiScenario.response().expectStatus(status);
  });

  Then(
    'the response status is one of {string}',
    ({ apiScenario }: ApiStepFixtures, list: string) => {
      const response = apiScenario.response();
      const accepted = list.split(',').map((s) => Number(s.trim()));
      if (!accepted.includes(response.status()))
        throw new Error(
          `Expected status ${accepted.join(' or ')} but got ${response.status()}\nBody: ${response.text().slice(0, 500)}`,
        );
    },
  );

  Then(
    'the response status is between {int} and {int}',
    ({ apiScenario }: ApiStepFixtures, min: number, max: number) => {
      apiScenario.response().expectStatusInRange(min, max);
    },
  );

  Then('the response is successful', ({ apiScenario }: ApiStepFixtures) => {
    apiScenario.response().expectStatusInRange(200, 299);
  });

  Then(
    'the response header {string} is {string}',
    ({ apiScenario, vars }: ApiStepFixtures, name: string, value: string) => {
      apiScenario.response().expectHeader(name, vars.interpolate(value));
    },
  );

  Then(
    'the response header {string} contains {string}',
    ({ apiScenario, vars }: ApiStepFixtures, name: string, part: string) => {
      apiScenario
        .response()
        .expectHeader(
          name,
          new RegExp(vars.interpolate(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        );
    },
  );

  Then(
    'the response sets the cookie {string}',
    ({ apiScenario }: ApiStepFixtures, name: string) => {
      const response = apiScenario.response();
      if (!response.cookies().some((cookie) => cookie.name === name))
        throw new Error(
          `Expected a Set-Cookie for "${name}"; got: ${
            response
              .cookies()
              .map((c) => c.name)
              .join(', ') || '(none)'
          }`,
        );
    },
  );

  Then(
    'the response field {string} equals {string}',
    ({ apiScenario, vars }: ApiStepFixtures, field: string, expected: string) => {
      const response = apiScenario.response();
      const actual = asText(response.require(field));
      const wanted = vars.interpolate(expected);
      if (actual !== wanted)
        throw new Error(
          `Expected "${field}" to be ${JSON.stringify(wanted)} but got ${JSON.stringify(actual)}\nBody: ${response.text().slice(0, 500)}`,
        );
    },
  );

  Then('the response field {string} is true', ({ apiScenario }: ApiStepFixtures, field: string) => {
    const actual = apiScenario.response().require(field);
    if (actual !== true)
      throw new Error(`Expected "${field}" to be true but got ${JSON.stringify(actual)}`);
  });

  Then(
    'the response field {string} is false',
    ({ apiScenario }: ApiStepFixtures, field: string) => {
      const actual = apiScenario.response().require(field);
      if (actual !== false)
        throw new Error(`Expected "${field}" to be false but got ${JSON.stringify(actual)}`);
    },
  );

  Then(
    'the response field {string} is not empty',
    ({ apiScenario }: ApiStepFixtures, field: string) => {
      const actual = apiScenario.response().require(field);
      if (actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0))
        throw new Error(`Expected "${field}" not to be empty but it is ${JSON.stringify(actual)}`);
    },
  );

  Then('the response field {string} exists', ({ apiScenario }: ApiStepFixtures, field: string) => {
    apiScenario.response().require(field);
  });

  Then(
    'the response field {string} does not exist',
    ({ apiScenario }: ApiStepFixtures, field: string) => {
      const response = apiScenario.response();
      if (response.has(field))
        throw new Error(
          `Expected "${field}" to be absent but it is ${JSON.stringify(response.get(field))}`,
        );
    },
  );

  Then(
    'the response field {string} has {int} items',
    ({ apiScenario }: ApiStepFixtures, field: string, count: number) => {
      apiScenario.response().expectArrayLength(field, count);
    },
  );

  Then(
    'the response field {string} contains {string}',
    ({ apiScenario, vars }: ApiStepFixtures, field: string, part: string) => {
      const actual = apiScenario.response().require(field);
      const wanted = vars.interpolate(part);
      const found = Array.isArray(actual)
        ? actual.some((item) => asText(item) === wanted)
        : asText(actual).includes(wanted);
      if (!found)
        throw new Error(
          `Expected "${field}" to contain ${JSON.stringify(wanted)} but it is ${JSON.stringify(actual)}`,
        );
    },
  );

  Then(
    'the response field {string} matches {string}',
    ({ apiScenario }: ApiStepFixtures, field: string, pattern: string) => {
      const actual = asText(apiScenario.response().require(field));
      if (!new RegExp(`^(?:${pattern})$`).test(actual))
        throw new Error(
          `Expected "${field}" to match /${pattern}/ but got ${JSON.stringify(actual)}`,
        );
    },
  );

  Then(
    'the response body contains {string}',
    ({ apiScenario, vars }: ApiStepFixtures, text: string) => {
      apiScenario.response().expectBodyContains(vars.interpolate(text));
    },
  );

  Then('the response body is empty', ({ apiScenario }: ApiStepFixtures) => {
    const response = apiScenario.response();
    if (response.text() !== '')
      throw new Error(`Expected an empty body but got: ${response.text().slice(0, 300)}`);
  });

  Then(
    'the response body matches JSON:',
    ({ apiScenario, vars }: ApiStepFixtures, docString: string) => {
      const response = apiScenario.response();
      const differences = subsetDifferences(
        response.body(),
        vars.interpolateDeep(JSON.parse(docString)),
      );
      if (differences.length > 0)
        throw new Error(
          `Response body does not match:\n  ${differences.join('\n  ')}\nBody: ${response.text().slice(0, 500)}`,
        );
    },
  );

  Then(
    'the response matches the JSON schema {string}',
    ({ apiScenario, vars }: ApiStepFixtures, file: string) => {
      apiScenario
        .response()
        .expectSchema(JSON.parse(fs.readFileSync(vars.interpolate(file), 'utf8')));
    },
  );

  Then('the response time is under {int} ms', ({ apiScenario }: ApiStepFixtures, maxMs: number) => {
    apiScenario.response().expectResponseTimeUnder(maxMs);
  });

  Then('the GraphQL response has no errors', ({ apiScenario }: ApiStepFixtures) => {
    apiScenario.response().expectNoGraphqlErrors();
  });

  Then('the file {string} exists and is not empty', ({ vars }: ApiStepFixtures, file: string) => {
    const resolved = vars.interpolate(file);
    if (!fs.existsSync(resolved) || fs.statSync(resolved).size === 0)
      throw new Error(`Expected ${resolved} to exist and not be empty`);
  });

  Then(
    'I remember the response field {string} as {string}',
    ({ apiScenario, vars }: ApiStepFixtures, field: string, name: string) => {
      vars.set(name, apiScenario.response().require(field));
    },
  );
}
