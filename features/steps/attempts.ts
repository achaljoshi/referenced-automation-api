import { createBdd } from 'playwright-bdd';
import { test } from './fixtures';
import { httpMethod, sendRequest } from './helpers';

const { When, Then } = createBdd(test);

// ---- "I try to ...": the request is expected to fail, and the scenario then says how ----

When(
  'I try to send a {word} request to {string}',
  async ({ apiClient, vars, apiScenario, attempt }, verb: string, path: string) => {
    attempt.ran = true;
    attempt.error = undefined;
    await sendRequest({ apiClient, vars, apiScenario }, verb, path).catch((error: unknown) => {
      attempt.error = error instanceof Error ? error : new Error(String(error));
    });
  },
);

function failure({ attempt }: { attempt: { ran: boolean; error?: Error } }): Error {
  if (!attempt.ran)
    throw new Error('Nothing was tried yet: a "When I try to ..." step must come first');
  if (!attempt.error) throw new Error('Expected the request to fail, but it succeeded');
  return attempt.error;
}

Then('the request fails', ({ attempt }) => {
  failure({ attempt });
});

// The pattern is a regular expression that may match anywhere in the message.
Then('the request fails with a message matching {string}', ({ attempt }, pattern: string) => {
  const message = failure({ attempt }).message;
  if (!new RegExp(pattern).test(message))
    throw new Error(`Expected the failure to match /${pattern}/ but it was: ${message}`);
});

Then('the request fails with the message {string}', ({ attempt }, expected: string) => {
  const message = failure({ attempt }).message;
  if (message !== expected)
    throw new Error(
      `Expected the failure message ${JSON.stringify(expected)} but it was ${JSON.stringify(message)}`,
    );
});

Then('the failure message does not contain {string}', ({ attempt }, text: string) => {
  const message = failure({ attempt }).message;
  if (message.includes(text))
    throw new Error(
      `The failure message must not contain ${JSON.stringify(text)} but it does: ${message}`,
    );
});

// ---- retries ----

When(
  'I send a POST request to {string} with JSON {string} and the idempotency key {string}',
  async ({ apiClient, vars, apiScenario }, path: string, json: string, key: string) => {
    await sendRequest({ apiClient, vars, apiScenario }, 'POST', path, {
      json: vars.interpolateDeep(JSON.parse(json)),
      idempotencyKey: vars.interpolate(key),
    });
  },
);

When(
  'I send a GET request to {string} with a generated idempotency key',
  async ({ apiClient, vars, apiScenario }, path: string) => {
    await sendRequest({ apiClient, vars, apiScenario }, 'GET', path, { idempotencyKey: true });
  },
);

When(
  'I send a GET request to {string} without retrying',
  async ({ apiClient, vars, apiScenario }, path: string) => {
    await sendRequest({ apiClient, vars, apiScenario }, 'GET', path, { retry: false });
  },
);

// What the client logged for the calls of this scenario: one entry per try, in order.
Then(
  'the call was attempted {int} times with the answers {string}',
  ({ apiClient }, count: number, answers: string) => {
    const tries = apiClient.exchanges().map((e) => [e.attempt, e.status] as const);
    const wanted = answers.split(',').map((s, i) => [i + 1, Number(s.trim())] as const);
    if (wanted.length !== count)
      throw new Error(`The step says ${count} attempts but lists ${wanted.length} answers`);
    if (JSON.stringify(tries) !== JSON.stringify(wanted))
      throw new Error(
        `Expected the attempts (number, status) ${JSON.stringify(wanted)} but got ${JSON.stringify(tries)}`,
      );
  },
);

Then(
  'the call was attempted {int} times, every one ending in a network error',
  ({ apiClient }, count: number) => {
    const exchanges = apiClient.exchanges();
    const attempts = exchanges.map((e) => e.attempt);
    const wanted = Array.from({ length: count }, (_, i) => i + 1);
    if (JSON.stringify(attempts) !== JSON.stringify(wanted))
      throw new Error(
        `Expected the attempts ${JSON.stringify(wanted)} but got ${JSON.stringify(attempts)}`,
      );
    if (!exchanges.every((e) => e.error !== undefined && e.status === undefined))
      throw new Error('Expected every attempt to end without an answer (a network error)');
  },
);

// A call that needed retries adds an "api-retries" note to the test report, so a passing test that leaned on them shows.
Then('the test report carries {int} retry note(s)', ({ $testInfo }, count: number) => {
  const notes = $testInfo.annotations.filter((a) => a.type === 'api-retries');
  if (notes.length !== count)
    throw new Error(`Expected ${count} retry note(s) in the report but found ${notes.length}`);
});

Then('the retry note reads like {string}', ({ $testInfo }, pattern: string) => {
  const note = $testInfo.annotations.find((a) => a.type === 'api-retries');
  if (!note) throw new Error('The report has no retry note');
  if (!new RegExp(pattern).test(note.description ?? ''))
    throw new Error(
      `Expected the retry note to match /${pattern}/ but it reads: ${note.description}`,
    );
});

// ---- the same request many times at once ----

When(
  'I send {int} {word} requests to {string} at the same time',
  async ({ apiClient, vars, parallel }, count: number, verb: string, path: string) => {
    const resolved = vars.interpolate(path);
    parallel.responses = await Promise.all(
      Array.from({ length: count }, () => apiClient.request(httpMethod(verb), resolved)),
    );
  },
);

Then('all {int} responses have the status {int}', ({ parallel }, count: number, status: number) => {
  const statuses = parallel.responses.map((r) => r.status());
  if (statuses.length !== count)
    throw new Error(`Expected ${count} responses but ${statuses.length} were received`);
  if (!statuses.every((s) => s === status))
    throw new Error(`Expected every response to be ${status} but got ${JSON.stringify(statuses)}`);
});
