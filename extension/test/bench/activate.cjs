// Loads the built extension (dist/extension.js) outside VS Code and calls its activate(), for the extension activation
// scenario of the benchmark runner (improvement roadmap t-03). `vscode` is a stand-in: every property is a function
// that returns another stand-in, so activate() runs every registration it makes without an editor. It measures the
// extension's own work (loading the bundle, building providers and views, reading settings), not VS Code's.
//
//   node test/bench/activate.cjs [dist/extension.js]
//
// Prints one JSON line on stdout: { loadMs, activateMs, registrations }. The runner adds the process's wall time,
// file reads and peak memory (benchProbe.cjs).
'use strict';
const Module = require('node:module');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

let registrations = 0;

/** A stand-in that can be called, constructed, awaited, iterated and printed, and whose properties are stand-ins. */
function standIn(name) {
  const target = function () {};
  const written = new Map();
  return new Proxy(target, {
    get(_, key) {
      if (written.has(key)) return written.get(key);
      if (key === 'then') return undefined; // not a promise, so `await` returns it
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'toString' || key === 'valueOf') return () => '';
      if (key === 'length') return 0;
      if (key === 'dispose') return () => undefined;
      return standIn(`${name}.${String(key)}`);
    },
    apply() {
      if (/\.(register\w*|create\w*|on\w+)$/.test(name)) registrations++;
      return standIn(`${name}()`);
    },
    construct() {
      return standIn(`new ${name}`);
    },
    set(_, key, value) {
      written.set(key, value);
      return true;
    },
    has() {
      return false;
    },
    // The bundle imports `vscode` through esbuild's __toESM, which copies own properties onto an object made from the
    // module's prototype: a stand-in prototype answers every name that isn't copied.
    getPrototypeOf() {
      return name === 'vscode' ? prototype : Function.prototype;
    },
  });
}

const prototype = new Proxy({}, { get: (_, key) => (key === 'then' ? undefined : standIn(`vscode.${String(key)}`)) });
const vscode = standIn('vscode');
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return load.call(this, request, parent, isMain);
};

const bundle = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', 'dist', 'extension.js'));
const memento = () => ({ get: (_k, fallback) => fallback, update: async () => undefined, keys: () => [], setKeysForSync: () => undefined });
const context = {
  subscriptions: [],
  extensionPath: path.dirname(path.dirname(bundle)),
  extensionUri: standIn('extensionUri'),
  globalState: memento(),
  workspaceState: memento(),
  secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: standIn('secrets.onDidChange') },
  storageUri: undefined,
  globalStorageUri: standIn('globalStorageUri'),
  logUri: standIn('logUri'),
  extensionMode: 1,
  asAbsolutePath: (rel) => path.join(path.dirname(path.dirname(bundle)), rel),
  environmentVariableCollection: standIn('environmentVariableCollection'),
  extension: standIn('extension'),
};

const t0 = performance.now();
const extension = require(bundle);
const loadMs = performance.now() - t0;
const t1 = performance.now();
Promise.resolve(extension.activate(context)).then(() => {
  const activateMs = performance.now() - t1;
  process.stdout.write(`${JSON.stringify({ loadMs, activateMs, registrations, subscriptions: context.subscriptions.length })}\n`);
  // Timers and watchers the stand-ins started would keep the process alive.
  process.exit(0);
}, (err) => {
  process.stderr.write(`activate() failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
