/** The step-registration functions of whichever BDD library is in use (playwright-bdd's `createBdd(test)` gives these). */
export type StepFunction = (
  pattern: string | RegExp,
  implementation: (fixtures: any, ...parameters: any[]) => unknown,
) => unknown;

export interface BddSteps {
  Given: StepFunction;
  When: StepFunction;
  Then: StepFunction;
}

/** The part of a Gherkin data table these steps use (playwright-bdd's DataTable has it). */
export interface TableLike {
  raw(): string[][];
  rowsHash(): Record<string, string>;
}
