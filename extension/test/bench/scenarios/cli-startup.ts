import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineScenario } from '../runner';

/**
 * Starting the built CLI (dist/cli.js) as a new process: Node alone for reference, `--version`, which loads the bundle
 * and does nothing else, and `validate` and `agent` on a small document. Needs `npm run build` first.
 */

const extension = path.join(__dirname, '..', '..', '..');
const cli = path.join(extension, 'dist', 'cli.js');
const doc = path.join(extension, 'test', 'snapshots', 'fixtures', 'token-budget.smd');

/** Why the scenario can't run, or undefined. */
export const missing = (): string | undefined => (fs.existsSync(cli) ? undefined : 'dist/cli.js is missing: run npm run build first');

const command = (args: string[]) => () => {
  const why = missing();
  if (why) throw new Error(why);
  return { args, cwd: extension };
};

export default defineScenario({
  name: 'cli-startup',
  description: 'A new process of the built CLI: Node alone, --version, and validate and agent on a small document.',
  tasks: ['t-23', 't-43'],
  kind: 'process',
  cases: [
    { name: 'node alone', command: () => ({ args: ['-e', '0'], cwd: extension }) },
    { name: 'smd --version', command: command([cli, '--version']) },
    { name: 'smd validate, small document', command: command([cli, 'validate', doc, '--today', '2026-11-01']) },
    { name: 'smd agent, small document', command: command([cli, 'agent', doc, '--today', '2026-11-01']) },
  ],
});
