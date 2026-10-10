import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { placeholders } from '@automation/referenced-automation-utils';
import { ApiClient } from '../src/client/apiClient';
import { fromXml } from '../src/client/xml';
import { registerApiSteps } from '../src/bdd';
import { ApiScenario } from '../src/bdd/scenario';
import { ApiResponse } from '../src/client/apiResponse';
import { startTestServer, stopTestServer, type TestServerHandle } from './support/testServer';

let server: TestServerHandle;
let context: APIRequestContext;
let client: ApiClient;

test.beforeAll(async () => {
  server = await startTestServer();
  context = await playwrightRequest.newContext();
  client = new ApiClient(context, server.baseUrl);
});

test.afterAll(async () => {
  await context.dispose();
  await stopTestServer(server);
});

test.describe('expectNoGraphqlErrors needs a real GraphQL response @regression', () => {
  test('a good response passes', async () => {
    const ok = await client.graphql('query { me }');
    expect(() => ok.expectNoGraphqlErrors()).not.toThrow();
  });

  test('an HTML 502 page, an empty body, a JSON body without data/errors and data:null all FAIL', async () => {
    for (const path of ['/graphql-html', '/graphql-empty', '/graphql-no-shape', '/graphql-null-data', '/graphql-json-502']) {
      const response = await client.graphql('query { me }', undefined, { path });
      expect(() => response.expectNoGraphqlErrors(), path).toThrow(/GraphQL/);
    }
  });

  test('errors are still reported as errors', async () => {
    const broken = await client.graphql('query { broken }');
    expect(() => broken.expectNoGraphqlErrors()).toThrow(/GraphQL returned 1 error/);
  });
});

test.describe('XML values stay text @regression', () => {
  test('leading zeros, a plus sign and attributes are kept (they used to become 123, 4412 and 7)', async () => {
    const response = await client.get('/xml-ids');
    expect(response.get('order.ref')).toBe('00123');
    expect(response.get('order.phone')).toBe('+4412');
    expect(response.get('order.qty')).toBe('7'); // text like every other XML value: compare with '7', or convert it yourself
    expect(response.get('order.@_id')).toBe('007');
  });

  test('fromXml keeps the text of every value', () => {
    expect(fromXml('<a><n>1</n><b>true</b><z>0042</z></a>')).toEqual({
      a: { n: '1', b: 'true', z: '0042' },
    });
  });
});

// The Gherkin steps, called directly: the step texts are registered on a fake Given/When/Then that collects them.
type Step = (fixtures: unknown, ...args: unknown[]) => unknown;
function steps(): (text: string) => Step {
  const registered = new Map<string | RegExp, Step>();
  const register = (pattern: string | RegExp, implementation: Step) => void registered.set(pattern, implementation);
  registerApiSteps({ Given: register, When: register, Then: register });
  return (text) => {
    const step = registered.get(text);
    if (!step) throw new Error(`step not registered: ${text}`);
    return step;
  };
}

/** A scenario whose last response has this JSON body. */
async function scenarioWith(body: unknown): Promise<{ apiScenario: ApiScenario; vars: placeholders.ScenarioVariables }> {
  const apiScenario = new ApiScenario();
  const mock = await playwrightRequest.newContext();
  try {
    const route = `${server.baseUrl}/form-echo`;
    // /form-echo answers { received: <what was posted> }: post the body as JSON and read the field under `received`
    const raw = await mock.post(route, { data: body });
    apiScenario.lastResponse = await ApiResponse.from(raw);
  } finally {
    await mock.dispose();
  }
  return { apiScenario, vars: new placeholders.ScenarioVariables() };
}

test.describe('BDD equality steps are typed @regression', () => {
  const step = steps();
  const equalsText = step('the response field {string} equals {string}');
  const equalsAsText = step('the response field {string} equals {string} as text');
  const equalsNumber = step('the response field {string} equals {float}');
  const notEmpty = step('the response field {string} is not empty');

  test('a string equals the same text; the number 1 and true do NOT equal "1" and "true"', async () => {
    const fixtures = await scenarioWith({ name: 'Ada', n: 1, flag: true, none: null });
    expect(() => equalsText(fixtures, 'received.name', 'Ada')).not.toThrow();
    expect(() => equalsText(fixtures, 'received.n', '1')).toThrow(/the text "1" but got a number 1/);
    expect(() => equalsText(fixtures, 'received.flag', 'true')).toThrow(/the text "true" but got a boolean true/);
    expect(() => equalsText(fixtures, 'received.name', 'Grace')).toThrow(/Expected "received.name"/);
  });

  test('"as text" compares the text form, for numbers and booleans too', async () => {
    const fixtures = await scenarioWith({ n: 1, flag: true, name: 'Ada' });
    expect(() => equalsAsText(fixtures, 'received.n', '1')).not.toThrow();
    expect(() => equalsAsText(fixtures, 'received.flag', 'true')).not.toThrow();
    expect(() => equalsAsText(fixtures, 'received.n', '2')).toThrow(/read "2" as text/);
  });

  test('a bare number equals a JSON number, and not a string of digits', async () => {
    const fixtures = await scenarioWith({ n: 3, s: '3', f: 2.5 });
    expect(() => equalsNumber(fixtures, 'received.n', 3)).not.toThrow();
    expect(() => equalsNumber(fixtures, 'received.f', 2.5)).not.toThrow();
    expect(() => equalsNumber(fixtures, 'received.s', 3)).toThrow(/the number 3 but got a string "3"/);
    expect(() => equalsNumber(fixtures, 'received.n', 4)).toThrow(/Expected "received.n"/);
  });

  test('"is not empty" rejects null, "", [] and {}; a number (0 included) or false is a value', async () => {
    const fixtures = await scenarioWith({
      nul: null,
      text: '',
      list: [],
      obj: {},
      zero: 0,
      no: false,
      full: { a: 1 },
      items: [1],
      name: 'x',
    });
    for (const field of ['nul', 'text', 'list', 'obj'])
      expect(() => notEmpty(fixtures, `received.${field}`), field).toThrow(/not to be empty/);
    for (const field of ['zero', 'no', 'full', 'items', 'name'])
      expect(() => notEmpty(fixtures, `received.${field}`), field).not.toThrow();
  });
});

test.describe('BDD steps may call another system by naming its full URL @regression', () => {
  test('a step that names a full URL reaches the other host; a client call with the same URL is still refused', async () => {
    const other = await startTestServer();
    try {
      const send = steps()('I send a {word} request to {string}');
      const apiScenario = new ApiScenario();
      const vars = new placeholders.ScenarioVariables();
      await send({ apiClient: client, vars, apiScenario }, 'GET', `${other.baseUrl}/xml-ids`);
      expect(apiScenario.lastResponse?.status()).toBe(200);
      await expect(client.get(`${other.baseUrl}/xml-ids`)).rejects.toThrow(/Refusing to send to the full URL/);
    } finally {
      await stopTestServer(other);
    }
  });
});
