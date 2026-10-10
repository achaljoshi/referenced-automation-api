import { placeholders, loadEnv } from '@automation/referenced-automation-utils';
import type { BddSteps } from './types';
import { projectDir } from '../util/projectDir';

const { randomValue, relativeDate } = placeholders;
type Vars = placeholders.ScenarioVariables;

/**
 * Data steps with no UI or API in them - only the scenario's named values - so every kind of feature shares one way
 * to say "remember this for later" and to make data that must be unique or fresh.
 *
 * NOTE: the UI package ships a copy of this file that registers the SAME step texts. A project that registers both
 * (`registerDataSteps` from here AND from the UI package) gets "ambiguous step" errors from the BDD tool: register the
 * data steps once, from either package. (The copies are kept identical on purpose so features read the same
 * whichever is used; making them non-ambiguous means renaming steps in both repos at once.)
 *
 *   Given I set the variable "customer" to "ACME-{{random:alnum(5)}}"
 *   And I generate a random email called "login"
 *   And the date 7 days from today is stored as "delivery"
 *   And I read the environment variable "API_BASE_URL" into "baseUrl"
 *   Then the variable "customer" matches "ACME-\w{5}"
 *
 * Any step text or table cell in the other libraries can then use {{customer}}, {{login}}, {{delivery}} ...
 */
export function registerDataSteps({ Given, Then }: Pick<BddSteps, 'Given' | 'Then'>): void {
  Given(
    'I set the variable {string} to {string}',
    ({ vars }: { vars: Vars }, name: string, value: string) => {
      vars.set(name, vars.interpolate(value));
    },
  );

  // A regular expression, not {word}: {word} would also match the quoted form below ("number(1,100)") and make every such step ambiguous.
  Given(
    /^I generate a random ([a-z-]+) called "([^"]*)"$/,
    ({ vars }: { vars: Vars }, kind: string, name: string) => {
      vars.set(name, randomValue(kind));
    },
  );

  Given(
    'I generate a random {string} called {string}',
    ({ vars }: { vars: Vars }, spec: string, name: string) => {
      vars.set(name, randomValue(spec));
    },
  );

  Given(
    'the date {int} days from today is stored as {string}',
    ({ vars }: { vars: Vars }, days: number, name: string) => {
      vars.set(name, relativeDate(`${days >= 0 ? '+' : ''}${days}d`));
    },
  );

  Given(
    'I read the environment variable {string} into {string}',
    ({ vars }: { vars: Vars }, key: string, name: string) => {
      vars.set(name, loadEnv({ dir: projectDir() }).get(key));
    },
  );

  Then(
    'the variable {string} equals {string}',
    ({ vars }: { vars: Vars }, name: string, expected: string) => {
      const actual = vars.require(name);
      const wanted = vars.interpolate(expected);
      if (actual !== wanted)
        throw new Error(
          `Variable "${name}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`,
        );
    },
  );

  Then(
    'the variable {string} matches {string}',
    ({ vars }: { vars: Vars }, name: string, pattern: string) => {
      const actual = vars.require(name);
      if (!new RegExp(`^(?:${pattern})$`).test(actual))
        throw new Error(
          `Variable "${name}" is ${JSON.stringify(actual)}, which does not match /${pattern}/`,
        );
    },
  );

  Then('the variable {string} is not empty', ({ vars }: { vars: Vars }, name: string) => {
    if (vars.require(name).trim() === '') throw new Error(`Variable "${name}" is empty`);
  });
}
