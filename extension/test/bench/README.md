# Benchmarks

Four tools live here.

| Tool | Command | What it is for |
| ---- | ------- | -------------- |
| `runner.ts` and `scenarios/` | `npm run bench:scenarios` | Named scenarios measured before and after a change. Every performance task of the improvement roadmap (M2) records its baseline here |
| `bench.ts` | `npm run bench` | Ceilings on large synthetic documents. CI runs it with `--check` to catch slowdowns of ten times or more |
| `profile.ts` | `npm run bench:profile` | Parse counts and latency of the read paths, for [docs/reports/performance.md](../../../docs/reports/performance.md) |
| `netTokens.ts` | `npm run bench:tokens` | The token cost of agent views |

## The scenario runner

The runner (improvement roadmap t-03) measures each case of a scenario in up to three modes.

- **cold.** The parse cache is cleared and the case's `fresh` runs before each run, for example to start a new language server.
- **cached.** The case runs again on what the last run left.
- **incremental.** The case's `edit` makes the next small edit before each run.

A process case starts a new Node process each run, so it has the cold mode only. CLI startup and extension activation are process cases.

For each case and mode it records these.

- **Latency.** The median, 95th percentile, mean, standard deviation and coefficient of variation (cv) of the timed runs. The cv says how noisy the runs were. Above about 20%, use more runs before trusting a difference.
- **Parse counts.** `parseSmd` calls, cache hits and misses, and full and incremental block parses, from one counted run (in-process cases only).
- **File system calls.** File reads and distinct files read, and the stats and folder listings that finding files takes. They are counted on the `fs` module, so every caller is seen. A process case counts them in the child with `benchProbe.cjs`, which also sees Node load the bundle.
- **Memory.** In-process, the most heap one run added, measured from a collected heap. Process cases give the child's peak resident memory.

### Shared scenarios

| Scenario | Cases | Tasks |
| -------- | ----- | ----- |
| `workspace-discovery` | `collect` over 200 documents, language server workspace symbols over 40 and 200 | t-20, t-26, t-50 |
| `references-rename` | Find references and rename of a block id every document links to, 40 and 200 documents, with unsaved text in the open document | t-20, t-50 |
| `include-reads` | Validate, render and agent view of a document with nested and repeated includes | t-19, t-21 |
| `cli-startup` | Node alone, `smd --version`, and `validate` and `agent` on a small document | t-23, t-43 |
| `extension-activation` | Loading `dist/extension.js` and running `activate()` against a stand-in `vscode` module (`activate.cjs`), with the load and activate phases timed apart | t-22, t-23 |
| `rule-chain` | A section read carrying a rule chain of 10, 25 and 49 rounds, and one past the 50-block limit | t-17, t-58 |
| `protected-budget` | Budgeted agent views of documents with many danger, rule and agent blocks | t-27 |

The process scenarios need `npm run build` first.

The activation scenario measures the extension's own work, which is loading the bundle and making its registrations. VS Code's part is not in it. The stand-in answers every call with another stand-in, so code that branches on what VS Code returns takes the path for an empty editor.

### Commands

Run these from `extension/`.

```bash
npm run bench:scenarios -- --list
```

```bash
npm run bench:scenarios -- --only references-rename
```

`--only` keeps the cases whose "scenario / case" contains the text. `--runs` sets the timed runs per mode (default 15) and `--warmup` the untimed runs before them (default 3). `--quick` is 3 runs after 1 warm-up, to check a scenario works. `--json` prints the results as JSON.

### Before and after a change

1. On the commit before the change, run `npm run build`, then save the results with `npm run bench:scenarios -- --only <scenario> --out before.json`.
2. Make the change and build again.
3. Run `npm run bench:scenarios -- --only <scenario> --compare before.json`.

The comparison calls a median faster or slower only when it moved by more than 5% and by more than twice the larger standard deviation. Anything less reads as "same". Counts are compared exactly, and any that changed are listed, for example `parseMisses 40 → 1`. Put the table and the comparison in the pull request, with the machine line the runner prints. A task whose measurement shows no gain closes with a note and no code change, as M2 says.

### Adding a scenario

Add a file to `scenarios/`. The runner loads every file there, so it needs no change.

```ts
import { defineScenario } from '../runner';

export default defineScenario({
  name: 'graph-traversal',
  description: 'What it measures, in one line.',
  tasks: ['t-17'],
  cases: [{
    name: 'trace, 40 documents',
    setup: () => makeTheInput(),
    teardown: (input) => removeIt(input),
    fresh: (input) => dropWhatTheCaseKeeps(input),
    edit: (input, n) => makeTheNthEdit(input, n),
    run: (input) => theWorkMeasured(input),
  }],
});
```

- `name` is how saved results are matched, so keep it stable: lowercase words joined by hyphens.
- Every function but `run` is optional. Without `edit` the case has no incremental mode, and `modes` limits the modes further.
- `workspace.ts` makes a workspace of linked documents and drives a language server in the same process. `profile.ts` has the include composite and an `edited` helper.
- A process case gives `command` instead of `run`, and `metrics` to read numbers the process prints on its last stdout line. Set `kind: 'process'` on the scenario.

`test/benchRunner.test.ts` runs the first case of every in-process scenario with two runs, and the CLI startup and activation scenarios after a build, so a broken scenario fails `npm test`.
