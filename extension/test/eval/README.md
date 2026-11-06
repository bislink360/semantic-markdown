# Evaluation harness (C03)

Tooling for Study 1 (`research/study-1-agent-evaluation.smd`): a corpus format and validator, a renderer for every condition, an offline evidence survival check, and a task scorer. It calls no model and sends nothing anywhere. The model runs, the corpus, the annotations and the tasks are the research author's work, not this code's.

The fixture in `fixture/` only tests the harness. It is not study data (see `fixture/README.md`).

## Commands

Run from `extension/`. The corpus defaults to `research/corpus/` in the repository. Relative paths are read from the folder you ran npm in.

```sh
npm run eval -- validate [corpus] [--json]
npm run eval -- render [corpus] --out <dir> [--tokenizer o200k_base]
npm run eval -- check [corpus] [--json] [--out <dir>]
npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed 1] [--resamples 2000] [--baseline M1] [--judged judged.jsonl]
```

- `validate` exits with 1 when there are errors. Warnings and the similarity number do not fail it.
- `render` writes `<doc>/<condition>.txt`, `<doc>/<task>/<condition>.txt` and `manifest.json` (tokens and metadata, no text).
- `check` prints the survival tables. With `--out` it also writes `survival.json` and `survival.md`.
- `score` writes `outcomes.json`, `outcomes.csv`, `summary.json`, `summary.md`, `judge-packets.jsonl` and `judge-key.jsonl`.

`--tokenizer` needs the optional `js-tiktoken` package. Without it every count is an estimate (characters / 4).

## Corpus format

```
<corpus>/corpus.json              optional: {"version": "1.0", "today": "2026-11-01"}
<corpus>/<doc>/doc.md             plain Markdown
<corpus>/<doc>/doc.smd            the same text plus markup
<corpus>/<doc>/annotations.json   {"guide": "...", "items": [...]}
<corpus>/<doc>/tasks.json         {"tasks": [...]}
```

Folders starting with `.` or `_` are skipped. Includes resolve relative to the document and only inside the corpus folder. `today` fixes overdue dates in agent views so renders are the same every day. The TypeScript types in `types.ts` are the full schema.

### Annotation item

```json
{ "id": "retry-limit", "kind": "limit", "md": [16, 16], "smd": [22, 22],
  "evidence": ["retried up to 8 times", {"regex": "outage lasted (3|three) hours"}],
  "annotator": "ana", "notes": "optional" }
```

- `kind` is one of `fact`, `constraint`, `negation`, `limit`, `decision-status`, `open-question`.
- `md` and `smd` are line spans, 1-based and inclusive, in each file.
- `evidence` lists what must appear for the item to count as shown. All entries must appear. Phrases and regexes are matched against normalised text: lower case, `*`, `_`, backticks and `~` removed, curly quotes and dashes made plain, whitespace collapsed. A regex gets the `i` flag unless `flags` is given.

### Task

Every task has `id` (unique across the corpus), `type`, `prompt`, `items` (annotation ids), and `expected`. `author`, `notes` and `violations` are optional.

| type | expected | correct when |
|-|-|-|
| `fact-lookup` | `{"accepted": ["8", "eight"]}` | the answer equals one accepted answer after normalising |
| `constraint-check` | `{"verdict": ["no"], "constraint": "https-only"}` | the verdict matches and the answer cites the constraint (its id in `cited`, or a line span overlapping its span) |
| `decision-status` | `{"option": ["cursor pagination"], "superseded": ["offset pagination"]}` | the option matches; choosing a superseded one is recorded on its own |
| `open-question` | `{"fallback": ["only through the API"]}` | `undecided` is true and the fallback matches |
| `qualification` | `{"rubric": [{"id": "r1", "text": "...", "items": ["..."]}]}` | not scored here: written to judge packets |
| `edit-plan` | `{"md": [[16, 16]], "smd": [[22, 22]]}` | every expected line is found and at least half the planned lines are expected |

Normalising answers also drops digit group commas, outer punctuation and a leading "the", "a" or "an".

`violations` is a list of `{"item": "<constraint id>", "answers": ["..."]}`. An answer that matches one breaks that constraint. A constraint check with a wrong, non-empty verdict also breaks its constraint.

### What the validator checks

Errors: missing files, bad JSON, repeated item ids in a document, repeated task ids anywhere in the corpus, unknown kinds and types, spans outside the file, evidence that does not compile or is not inside the stated span of both files, tasks that name unknown items, missing or inconsistent `expected` fields.

Warnings: evidence that also appears outside its span (the survival check cannot tell copies apart), items no task uses, `.smd` validation errors.

Similarity: the `.smd` text with markup removed is compared with the `.md` text line by line (2 × longest common subsequence / total lines). 1 means the same lines. It is reported, never enforced.

## Conditions

| id | what it shows | lines |
|-|-|-|
| `M1` | `doc.md` whole | md |
| `M2-outline` | the first M2 call only: the heading list of `doc.md` | md |
| `M2-oracle` | heading list, then the sections holding the task's items (line ranges for items above the first heading) | md |
| `S1` | `doc.smd` raw | smd |
| `S2` | whole agent view | smd |
| `S3-oracle` | MCP `read` with `mode: "outline"`, then `read` of the sections holding the task's items | smd |
| `S4-brief` | brief agent view | smd |
| `S4-budget` | agent view with `maxTokens` at half the full view's estimated tokens | smd |
| `O` | agent view of the sections holding the task's items | smd |

M2 and S3 as the study defines them let the model choose what to read. That needs a model run. Offline, the harness renders the oracle choice and marks it. When every item of a task is above the first heading, the oracle reads the whole view instead and says so.

S3 starts with `mode: "outline"`, not `auto`, so short documents still go through the outline. The model harness should decide which one the study uses and record it.

The M2 tool (`mdTool.ts`) has the call shape of MCP `read` (`file`, `sections`, `exact`, `mode`, `maxTokens`) plus `query` (lines containing a text) and `lines` (a range). It returns the file as written. `MD_READ_SCHEMA` is its JSON schema for the model harness.

Ablations, written as `<condition>.<ablation>`, run on S2 and S3-oracle:

- `all-audiences`: `:::human` kept and `{agent=skip}` marks taken out of the source.
- `plain-blocks`: the fences of `:::agent`, callouts (with `:::question`), decisions and risks removed, titles and text kept.
- `no-agent-block`: `:::agent` blocks removed.
- `no-doc-context`: `:::agent` blocks outside the selected sections removed, so the "Document-wide agent instructions" block is gone. It does not apply to S2.

Every rewrite keeps the number of lines, so spans and `[L12]` references stay valid.

Transcripts use one block per call: a `>>> read {"file": ...}` line, then the result. Only the results count as what the model read.

## Evidence survival check

For each condition and item, `check` asks whether all of the item's evidence appears in what the condition shows. It is a deterministic projection check with no model. It is not task accuracy. An item can be shown and still be misread, and a phrase that appears twice counts wherever it appears.

## Scoring

Answers are JSON lines:

```json
{"task": "wh-02", "condition": "S2", "run": 1, "seed": 7, "model": "model-id",
 "answer": {"verdict": "no"}, "cited": ["https-only"], "lines": [[18, 18]],
 "usage": {"input_tokens": 380, "output_tokens": 4}}
```

`answer` is a string or an object with `text`, `verdict`, `option`, `undecided` and `fallback`, or `lines`. Add `doc` only if task ids repeat. Conditions whose id starts with `M` use `doc.md` line numbers. The rest use `doc.smd`.

Per-task outcomes go to `outcomes.json` and `outcomes.csv`. Per condition, `summary.md` reports correctness, the difference from the baseline, constraint violations and use of superseded options, each with a 95% interval from a seeded paired bootstrap. Each resample draws documents with replacement, then tasks within each drawn document, and uses the same draws for every condition. A unit is a (document, task) pair, scored as the mean over its runs.

Provider token counts (`usage`) and estimates (characters / 4) are kept in separate fields and columns. `shownTokensEstimate` is only filled for conditions the renderer can reproduce.

### Judge packets

Qualification answers are written to `judge-packets.jsonl` in a seeded random order. A packet holds the task, the rubric, the annotated items as plain Markdown text, and the answer. It never holds the condition. `judge-key.jsonl` maps packet ids back to answers. Keep it away from judges. Pass the judgements back with `--judged`, one line per packet: `{"packet": "9e64247cc329", "correct": 1, "violation": false}`.
