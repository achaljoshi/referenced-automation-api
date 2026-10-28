import { createBdd } from 'playwright-bdd';
import { test } from './fixtures';

const { Given, Then } = createBdd(test);

// Steps for what only this repo's in-process test server (tests/support/testServer.ts) offers.

Given('the address of the service is stored as {string}', ({ testServer, vars }, name: string) => {
  vars.set(name, testServer.baseUrl);
});

// A gateway puts the API under a path prefix (https://host/api/v1). The client is pointed at it, and the scenario can use
// {{gatewayUrl}} (with the prefix) and {{gatewayOrigin}} (host only).
Given(
  'the service is behind the gateway path {string}',
  async ({ services, apiClient, vars }, prefix: string) => {
    const gateway = await services.start('gateway', prefix);
    apiClient.setBaseUrl(gateway.baseUrl);
    vars.set('gatewayUrl', gateway.baseUrl);
    vars.set('gatewayOrigin', gateway.origin);
  },
);

// Another host, to call by its full URL: {{otherUrl}}.
Given('another service is running', async ({ services, vars }) => {
  const other = await services.start('other');
  vars.set('otherUrl', other.baseUrl);
});

Then(
  'the {word} service last received the request {string}',
  ({ services }, name: string, url: string) => {
    const last = services.get(name).requests.at(-1)?.url;
    if (last !== url)
      throw new Error(
        `Expected the ${name} service to have last received ${url} but it was ${last}`,
      );
  },
);

// The test server counts some calls by key (`GET /calls/<key>`): token requests, logins, POST attempts. The count is read
// directly, not through the API client, so reading it never triggers a login or a token request of its own.
Then(
  'the test service has seen {int} call(s) to {string}',
  async ({ testServer, vars }, expected: number, key: string) => {
    const reply = await fetch(`${testServer.baseUrl}/calls/${vars.interpolate(key)}`);
    const { calls } = (await reply.json()) as { calls: number };
    if (calls !== expected)
      throw new Error(
        `Expected the test service to have seen ${expected} call(s) to "${vars.interpolate(key)}" but it saw ${calls}`,
      );
  },
);
