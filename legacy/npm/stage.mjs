// Stages the npm package under its pre-3.0 name, `styled-markdown`: a copy of the built npm/ folder (run
// `npm run build:npm` in extension/ first) with a renamed package.json and this folder's README. Then
// `npm pack` in the staged folder gives styled-markdown-X.Y.Z.tgz.
//
//   node legacy/npm/stage.mjs <out-dir>
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', '..', 'npm');
const out = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node legacy/npm/stage.mjs <out-dir>');
if (!existsSync(join(source, 'dist', 'cli.js'))) throw new Error('npm/dist is missing: run npm run build:npm in extension/ first.');

rmSync(out, { recursive: true, force: true });
cpSync(source, out, { recursive: true, filter: (path) => !path.includes('node_modules') });
const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
if (pkg.name !== 'semantic-markdown') throw new Error(`npm/package.json is "${pkg.name}", expected "semantic-markdown".`);
pkg.name = 'styled-markdown';
pkg.description = `Renamed to semantic-markdown. ${pkg.description}`;
// The MCP registry entry (server.json) belongs to the new package only.
delete pkg.mcpName;
// `npx styled-markdown …` keeps running the CLI, as it did before 3.0.
const bin = { ...pkg.bin };
delete bin['semantic-markdown'];
pkg.bin = { ...bin, 'styled-markdown': pkg.bin['semantic-markdown'] };
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
cpSync(join(here, 'README.md'), join(out, 'README.md'));
console.log(`staged styled-markdown@${pkg.version} → ${out}`);
