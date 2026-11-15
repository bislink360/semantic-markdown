// Loaded with `node --require` into every process the benchmark runner starts (test/bench/runner.ts, process cases).
// It counts the process's file reads (with distinct paths), stats and folder listings, as the runner counts them in
// its own process, and at exit writes them with the peak resident memory to the file SMD_BENCH_PROBE names.
'use strict';
const fs = require('node:fs');

const report = process.env.SMD_BENCH_PROBE;
if (report) {
  const write = fs.writeFileSync; // kept before wrapping, so the report itself is not counted
  const paths = [];
  let fileStats = 0;
  let dirListings = 0;
  const wrap = (owner, name, count) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = Object.assign(function (...args) {
      count(args);
      return original.apply(this, args);
    }, original);
  };
  const read = (args) => paths.push(String(args[0]));
  const stat = () => { fileStats++; };
  const list = () => { dirListings++; };
  for (const name of ['readFileSync', 'readFile']) wrap(fs, name, read);
  for (const name of ['statSync', 'lstatSync', 'existsSync', 'stat', 'lstat']) wrap(fs, name, stat);
  for (const name of ['readdirSync', 'readdir']) wrap(fs, name, list);
  wrap(fs.promises, 'readFile', read);
  for (const name of ['stat', 'lstat']) wrap(fs.promises, name, stat);
  wrap(fs.promises, 'readdir', list);
  process.on('exit', () => {
    // maxRSS is in kilobytes.
    const peakRssMB = Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;
    write(report, JSON.stringify({ fileReads: paths.length, distinctFiles: new Set(paths).size, fileStats, dirListings, peakRssMB }));
  });
}
