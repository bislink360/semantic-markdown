import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineScenario } from '../runner';

/**
 * Loading the built extension (dist/extension.js) and calling activate() in a new process, with a stand-in for the
 * `vscode` module (test/bench/activate.cjs). It measures the extension's own work: loading the bundle, then the
 * registrations activate() makes. VS Code's part is not in it. Needs `npm run build` first.
 */

const extension = path.join(__dirname, '..', '..', '..');
const bundle = path.join(extension, 'dist', 'extension.js');

export default defineScenario({
  name: 'extension-activation',
  description: 'Loading dist/extension.js and running activate() against a stand-in vscode module, in a new process.',
  tasks: ['t-22', 't-23'],
  kind: 'process',
  cases: [
    {
      name: 'activate',
      command: () => {
        if (!fs.existsSync(bundle)) throw new Error('dist/extension.js is missing: run npm run build first');
        return { args: [path.join(__dirname, '..', 'activate.cjs'), bundle], cwd: extension };
      },
      metrics: (stdout) => {
        const last = JSON.parse(stdout.trim().split('\n').at(-1)!) as { loadMs: number; activateMs: number };
        return { 'load ms': last.loadMs, 'activate ms': last.activateMs };
      },
    },
  ],
});
