# Performance: parse counts and read latency

This page answers one question from the implementation review (C11). Does `smd read` do enough repeated work to need a cache? `readDocument` builds a full agent view and then, for a long document, calls `outline`, which builds another full view and the section costs. The editor's status bar builds a full and a brief view on every update. Nobody had measured what that costs.

Short answer, on one machine. Without includes, every call parses the document once. The existing parse cache answers all other lookups. The outline path repeats projection passes, not parsing. That costs about 2–3 ms on the large repo documents and about 29 ms on a 50k-token document. With `:::include`, included files are parsed and read several times per call, and the parse cache does not help. That is the one place where repeated work is clearly visible. It is still under 50 ms at p95 for the case measured.

No cache was added. Nothing in the view code was changed.

## What is measured

The profiler is `extension/test/bench/profile.ts`. For each document it runs these calls.

| Call | What it is |
|---|---|
| `readDocument full` / `readDocument outline` | `smd read` and MCP `read`. `outline` is what `auto` does for a document over the 2,000-token budget, a full view and then `outline` |
| `agentView`, `agentView brief`, `agentView section`, `agentView maxTokens=1000`, `agentView embed` | `smd agent` and its options. `section` asks for the first `##` heading |
| `outline`, `sectionCosts` | `smd outline` and the section costs it uses |
| `editor status` | A full and a brief view of the same text, as the status bar does on each update |
| `editor status after edit` | The same, with a small edit before each run |

For every call it records the following.

- **Parse counts.** `parseSmd` calls and cache hits, the block parses behind the misses (full or incremental), and the lines markdown-it read, also given as a multiple of the document's body lines. It also counts `expandedFigures` passes, which number figures and walk includes. The counts come from `parseCounts`, a small internal counter in `extension/src/core/parse.ts`. It is not API and nothing else reads it.
- **Reads.** The `readFile` callback is wrapped. It counts calls and distinct paths per call.
- **Latency.** p50, p95, min and max over 30 timed runs after 5 warm-up runs. Each call is timed twice. `cold` clears the parse cache before every run, like a fresh `smd read` process. `warm` keeps it, like a long-running MCP server or editor that sees the same text again.
- **Memory.** `process.memoryUsage()` before and after the timed runs, and the peak heap during them. This is rough. The garbage collector runs when it likes, so peak heap growth mostly shows garbage not yet collected.

The documents are the three large repo documents, the samples in `extension/test/samples/`, composites of about 8k, 20k and 50k tokens built from the samples (unique headings, one `:::agent` block), and one composite with includes. That one is a root of about 6k tokens. It includes `part-a.smd` whole, which includes `part-b.smd`, and it also includes one section of `part-b.smd` directly. Each part is about 1k tokens. The files are written to a new folder under the OS temp folder and removed afterwards. `today` is fixed at 2026-11-01.

## How to run it

```sh
cd extension
npm run bench:profile                 # table on stdout
npm run bench:profile -- --json       # raw numbers with machine, commit and settings
npm run bench:profile -- --runs 50 --warmup 3 --only composite
```

A full run takes about 1.5 minutes here. `test/profile.test.ts` is a smoke test that runs the measuring function on one small document with 2 runs.

## Machine and commit

| | |
|---|---|
| CPU | AMD Ryzen AI 9 HX PRO 370 (24 threads), 55.6 GB RAM |
| OS | Windows 11 (Windows_NT 10.0.26200 x64) |
| Node | v24.13.0, run with `--expose-gc` |
| Commit | `750ef2e` plus uncommitted local changes in `extension/src`, including in-progress work on `agentView.ts` |
| Settings | 30 timed runs per call and cache state, 5 warm-up runs |

All numbers below come from this one machine and one run. Treat them as rough sizes, not as limits.

## Results

### Parse counts

For every document without includes the counts were the same, from the 41-line sample to the 50k-token composite. Cold means a run that starts with an empty parse cache.

| Call | `parseSmd` calls (cache hits) | Block parses, cold | Block parses, warm | Figure passes |
|---|---:|---:|---:|---:|
| `readDocument full` | 7 (6) | 1 full | 0 | 1 |
| `readDocument outline` | 23–24 (22–23) | 1 full | 0 | 3 |
| `agentView`, `brief`, `embed` | 7 (6) | 1 full | 0 | 1 |
| `agentView section` | 12 (11) | 1 full | 0 | 1 |
| `agentView maxTokens=1000` | 8–14 (7–13) | 1 full | 0 | 1 |
| `outline` | 16–17 (15–16) | 1 full | 0 | 2 |
| `sectionCosts` | 7 (6) | 1 full | 0 | 1 |
| `editor status` (full + brief) | 14 (13) | 1 full | 0 | 2 |
| `editor status after edit` | 14 (13) | 1 full | 1 incremental | 2 |

markdown-it read each document's body exactly once per cold call. After an edit the warm run re-read 4–55% of the lines, depending on where the edit fell.

With includes the picture changes. Lines read are a multiple of the root's body lines, so the included files add to them. Reading every file once would be about 1.4×.

| Call | `parseSmd` calls (hits) | Block parses, cold | Block parses, warm | Lines read ×doc, cold | Reads (distinct) |
|---|---:|---:|---:|---:|---:|
| `readDocument full` | 27 (17) | 1 full + 9 incremental | 10 incremental | 2.9 | 6 (2) |
| `readDocument outline` | 84 (53) | 1 full + 30 incremental | 30 incremental | 9.8 | 18 (2) |
| `outline` | 57 (36) | 1 full + 20 incremental | 20 incremental | 6.9 | 12 (2) |
| `editor status` | 54 (34) | 1 full + 19 incremental | 20 incremental | 5.9 | 12 (2) |

Each view loads every `:::include` twice, once to number figures and once to show the text. The root has three includes (two direct, one nested), so one view makes six reads. The outline path builds three views, so it makes eighteen. The parse cache keeps the last three texts. An include brings in several texts per file (the file, its included lines, and the inline-text variants), so entries push each other out and the warm runs parse as much as the cold ones. That cause is read from the code. The profiler only shows the effect.

Code embeds (`agentView embed`) read the embedded file once per fence, with no reuse. The 50k composite read the same file 24 times in one call.

### Latency (ms, p50 / p95)

| Document | Tokens (file → view) | `readDocument full` cold | warm | `readDocument outline` cold | warm | `editor status` cold | warm |
|---|---|---:|---:|---:|---:|---:|---:|
| `docs/COLLABORATION-RFC.smd` | 8.3k → 6.4k | 5.3 / 8.3 | 1.5 / 3.0 | 8.3 / 13.9 | 3.9 / 5.2 | 8.0 / 11.2 | 2.3 / 4.2 |
| `docs/SPEC-V2-PROPOSALS.smd` | 6.0k → 5.5k | 4.6 / 7.5 | 1.1 / 3.0 | 7.3 / 10.8 | 3.0 / 4.6 | 5.0 / 7.8 | 1.8 / 2.3 |
| `implementation-changes.smd` | 9.8k → 8.0k | 3.9 / 7.3 | 1.0 / 1.5 | 6.2 / 9.2 | 2.8 / 4.3 | 4.9 / 7.5 | 1.8 / 2.6 |
| composite ≈8k | 9.8k → 6.7k | 8.0 / 13.4 | 2.1 / 2.6 | 13.0 / 15.8 | 7.0 / 8.2 | 11.3 / 16.2 | 4.4 / 5.0 |
| composite ≈20k | 20.0k → 14.3k | 14.8 / 19.4 | 4.5 / 5.5 | 26.2 / 39.5 | 14.4 / 17.3 | 21.4 / 30.1 | 9.0 / 10.3 |
| composite ≈50k | 50.6k → 36.1k | 36.0 / 49.8 | 12.3 / 14.2 | 64.9 / 84.0 | 39.5 / 41.4 | 43.9 / 57.2 | 23.0 / 24.0 |
| composite with includes | 6.1k → 6.5k | 12.4 / 18.2 | 10.8 / 12.8 | 34.0 / 46.9 | 30.6 / 39.8 | 22.1 / 32.6 | 20.3 / 21.8 |

Every call on every sample stayed under 6.4 ms at p95, cold. Standalone `outline` on the 50k composite took 49.2 / 65.7 ms cold.

One call stood out, and it has nothing to do with parsing. `agentView` with `maxTokens=1000` took 54 ms at p50 on the 20k composite and 495 ms on the 50k composite, warm or cold alike (467 ms warm). The time goes into fitting the budget, not into parsing. `readDocument` does not use that path. It only uses `maxTokens` to choose between the whole view and the outline.

### Memory

Peak heap growth during 60 timed runs was 20–150 MB, highest on the 50k composite. RSS grew by at most 55 MB. A forced GC ran before each call's runs but not between runs, so these numbers include garbage. They do not show retained memory.

## What the numbers say

- **Without includes the document is not parsed twice.** `readDocument` with the outline makes 23–24 `parseSmd` calls, but all except the first hit the cache. markdown-it reads the document once per cold call.
- **The double work is projection, not parsing.** The outline path does three figure passes and several transforms. On the repo documents it adds 2–3 ms at p50 over a full read. On the 50k composite it adds about 29 ms (64.9 vs 36.0 ms).
- **Parsing is most of a cold read.** Cold minus warm is the parse. It is about 70% of a cold `readDocument full` (36.0 vs 12.3 ms on the 50k composite, 5.3 vs 1.5 ms on the RFC). A fresh `smd read` process pays it once, and a long-running process pays it once per new text.
- **The editor's two projections share one parse.** After an edit the second view parses nothing. The first does an incremental update.
- **Includes are where repeated work shows.** Included files are read twice per view and parsed several times per call. The cache does not help, so warm latency is about cold latency (10.8 vs 12.4 ms for a full read). For a document of this size the absolute cost is still small.

On these numbers a cross-request cache is not warranted for documents without includes. The parse is already shared within a call and across calls on the same text. The remaining repeated work costs a few milliseconds on real documents. Two narrower follow-ups look worth measuring further. One is reusing included-file reads and parses within a single request. The other is the `maxTokens` budget path on very large documents.

## If a cache is added later

The review sets the conditions. A cache of parsed documents or views would need to key on all of the following.

- The document text and the revision of every file it reads (includes and embeds, nested ones too).
- The date policy, since `today` changes due dates and task state in the view.
- The spec version, from front matter and from the including document.
- The view options (`brief`, `sections`, `exactSections`, `includes`, `embed`, `includeHuman`, `lineRefs`, `maxTokens`, tokenizer, file).

A cross-request cache also needs bounded memory and invalidation. Accept it only when the output is identical and this profiler shows lower latency.
