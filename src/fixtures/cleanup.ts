import { getLogger } from '@automation/referenced-automation-utils';

const log = getLogger('cleanup');

/**
 * Things a test creates (users, orders, files) and must remove again. Register the undo right after the create;
 * after the test - passed or failed - every undo runs, newest first (so a child is deleted before its parent),
 * and one failing undo never stops the others. Failures are collected and reported together.
 *
 *   const user = (await client.post('/users', { json })).require<{ id: number }>('id');
 *   cleanup.add(`user ${user}`, () => client.delete('/users/{id}', { pathParams: { id: user } }));
 */
export class CleanupRegistry {
  private readonly tasks: Array<{ name: string; undo: () => Promise<unknown> | unknown }> = [];

  add(name: string, undo: () => Promise<unknown> | unknown): void {
    this.tasks.push({ name, undo });
  }

  get pending(): number {
    return this.tasks.length;
  }

  /** Runs everything registered, newest first. Throws one error listing every failure, after all have been tried. */
  async run(): Promise<void> {
    const failures: string[] = [];
    while (this.tasks.length > 0) {
      const task = this.tasks.pop() as { name: string; undo: () => Promise<unknown> | unknown };
      try {
        await task.undo();
        log.info(`cleaned up: ${task.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`cleanup failed: ${task.name}: ${message}`);
        failures.push(`${task.name}: ${message}`);
      }
    }
    if (failures.length > 0)
      throw new Error(`${failures.length} cleanup step(s) failed:\n  ${failures.join('\n  ')}`);
  }
}
