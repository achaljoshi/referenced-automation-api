import { createBdd } from 'playwright-bdd';
import { test } from './fixtures';
import { sendRequest } from './helpers';

const { When, Then } = createBdd(test);

When(
  'I send the GraphQL query {string} with the variables {string} and the operation name {string}',
  async (
    { apiClient, vars, apiScenario },
    query: string,
    variables: string,
    operationName: string,
  ) => {
    apiScenario.lastResponse = await apiClient.graphql(
      vars.interpolate(query),
      vars.interpolateDeep(JSON.parse(variables)) as Record<string, unknown>,
      { operationName: vars.interpolate(operationName) },
    );
  },
);

// GraphQL reports failures with status 200 and an "errors" list.
Then('the GraphQL response reports {int} error(s)', ({ apiScenario }, count: number) => {
  let message = '';
  try {
    apiScenario.response().expectNoGraphqlErrors();
  } catch (error) {
    message = (error as Error).message;
  }
  if (!new RegExp(`GraphQL returned ${count} error`).test(message))
    throw new Error(
      `Expected the GraphQL response to report ${count} error(s) but: ${message || 'it reported none'}`,
    );
});

When(
  'I send a SOAP {string} request to {string} for the action {string} with the body {string}',
  async (
    { apiClient, vars, apiScenario },
    version: string,
    path: string,
    action: string,
    body: string,
  ) => {
    if (version !== '1.1' && version !== '1.2')
      throw new Error(`SOAP version must be "1.1" or "1.2", not "${version}"`);
    apiScenario.lastResponse = await apiClient.soap(vars.interpolate(path), {
      action: vars.interpolate(action),
      body: vars.interpolate(body),
      version,
    });
  },
);

When(
  'I send a GET request to {string} without following redirects',
  async ({ apiClient, vars, apiScenario }, path: string) => {
    await sendRequest({ apiClient, vars, apiScenario }, 'GET', path, { maxRedirects: 0 });
  },
);
