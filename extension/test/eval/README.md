# Evaluation harness (C03)

Tooling for Study 1 (`research/study-1-agent-evaluation.smd`): a corpus format and validator, a span mapper and an agreement report for the annotations, a renderer for every condition, an offline evidence survival check, a model runner, a task scorer, and a model judge with its blind human check. The corpus, the annotations and the tasks are the research author's work, not this code's.

Only `run` and `judge` call a model, and only with an explicit config file and keys read from environment variables. Every other command sends nothing anywhere.

The fixture in `fixture/` only tests the harness. It is not study data (see `fixture/README.md`).

## Commands

Run from `extension/`. The corpus defaults to `research/data/corpus/` in the repository. Relative paths are read from the folder you ran npm in.

```sh
npm run eval -- validate [corpus] [--json]
npm run eval -- map-spans [corpus] [--write] [--json]
npm run eval -- agreement [corpus] --a <file> --b <file> [--pairs <file>] [--json] [--out <dir>]
npm run eval -- compare-marks [corpus] --other <dir> [--json] [--out <dir>]
npm run eval -- render [corpus] --out <dir> [--tokenizer o200k_base]
npm run eval -- check [corpus] [--json] [--out <dir>]
npm run eval -- run [corpus] --config <run.json> --out <dir> [--dry-run | --setup-probe] [--docs a,b] [--tasks a,b] [--conditions a,b] [--runs n] [--limit n] [--concurrency n]
npm run eval -- score <corpus> <answers.jsonl> --out <dir> [--seed 1] [--resamples 2000] [--baseline M1] [--judged a.jsonl,b.jsonl] [--model <label>] [--ni-margin 0.05] [--eq-margin 0.05] [--config run.json]
npm run eval -- power [--accuracy 0.8] [--diff 0] [--ni-margin 0.05] [--eq-margin 0.05] [--docs 12,24,36] [--tasks 10] [--runs 1] [--icc 0.1] [--task-icc 0.3] [--doc-corr 0.5] [--task-corr 0.5] [--alpha 0.025] [--sims 1000] [--seed 1] [--method scorer|cluster|bootstrap] [--resamples 2000] [--pilot outcomes.json [--reference M1] [--condition S3]] [--out <dir>] [--json]
npm run eval -- judge <judge-packets.jsonl> --config <run.json> --out <dir> [--model <label>] [--dry-run] [--limit n] [--concurrency n]
npm run eval -- sample <judge-packets.jsonl> --out <dir> [--share 0.15 | --count 50] [--seed 1]
npm run eval -- judge-agreement <judge-packets.jsonl> --judged <files> --human <files> [--out <dir>] [--json]
npm run eval -- tokens <run dir> [--out <dir>] [--scored outcomes.json] [--model <label>] [--seed 1] [--resamples 2000] [--baseline M1] [--json]
```

- `validate` exits with 1 when there are errors. Warnings and the similarity number do not fail it.
- `map-spans` fills the `smd` spans from the `md` spans (see [Mapping spans](#mapping-spans)). It only reports unless you pass `--write`, and exits with 1 when an item could not be mapped or its evidence is not inside the mapped span.
- `agreement` compares two annotators' files (see [Agreement](#agreement)). With `--out` it also writes `agreement.json` and `agreement.md`.
- `compare-marks` compares the corpus marking with an independent re-marking (see [Marker comparison](#marker-comparison)). With `--out` it also writes `marker-comparison.json` and `marker-comparison.md`.
- `render` writes `<doc>/<condition>.txt`, `<doc>/<task>/<condition>.txt` and `manifest.json` (tokens and metadata, no text).
- `check` prints the survival tables. With `--out` it also writes `survival.json` and `survival.md`.
- `run` asks the models (see [Model runs](#model-runs)). It exits with 1 when an answer failed. With `--setup-probe` it sends only the setup probe (see [Token accounting](#token-accounting)).
- `score` writes `outcomes.json`, `outcomes.csv`, `summary.json`, `summary.md`, `judge-packets.jsonl` and `judge-key.jsonl`. The summary pools every answer of a condition, so score one model at a time with `--model <label>` (it keeps records whose `model` is the label or starts with `<label>:`).
- `power` simulates the power of the correctness comparison for a grid of sample sizes (see [Sample size and power](#sample-size-and-power)). With `--out` it writes `power.json` and `power.md`.
- `tokens` reads a run folder and writes the token accounting (see [Token accounting](#token-accounting)). It exits with 1 when the folder holds no transcripts.
- `judge`, `sample` and `judge-agreement` score qualification answers with a model judge and check it against people (see [Model judge](#model-judge)). `judge` exits with 1 when a packet failed.

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
- `md` and `smd` are line spans, 1-based and inclusive, in each file. Annotators record `md` only; `map-spans` fills `smd`. The validator requires both.
- An item in a passage that `doc.smd` pulls in with `:::include` has the `:::include` block as its `smd` span (opening to closing line), since `doc.smd` has no lines of its own for that text. `doc.md` writes the passage out, so its `md` span is the passage's lines.
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

Errors: missing files, bad JSON, repeated item ids in a document, repeated task ids anywhere in the corpus, unknown kinds and types, missing spans and spans outside the file, evidence that does not compile or is not inside the stated span of both files, tasks that name unknown items, missing or inconsistent `expected` fields.

In `doc.smd`, an `:::include` block inside a span stands for the included text: evidence is looked for in the included file's lines (read through the corpus reader, so only inside the corpus folder), and the "outside the span" warning reads included text outside the span the same way. A `doc.smd` without includes is checked line by line as before.

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

M2 and S3 as the study defines them let the model choose what to read. `run` does that (see [Model runs](#model-runs)). Offline, `render` and `check` show the oracle choice and mark it. When every item of a task is above the first heading, the oracle reads the whole view instead and says so.

S3-oracle starts with `mode: "outline"`, not `auto`, so short documents still go through the outline. In `run`, S3 is MCP `read` as the server runs it: the model picks the mode, and without one it is `auto`, so a document whose view fits 2,000 tokens comes back whole on the first call. The run manifest records this.

The M2 tool (`mdTool.ts`) has the call shape of MCP `read` (`file`, `sections`, `exact`, `mode`, `maxTokens`) plus `query` (lines containing a text) and `lines` (a range). It returns the file as written. `MD_READ_SCHEMA` and `MD_READ_DESCRIPTION` are what `run` gives the model.

Ablations, written as `<condition>.<ablation>`, run on S2 and S3 (S3-oracle offline):

- `all-audiences`: `:::human` kept and `{agent=skip}` marks taken out of the source.
- `plain-blocks`: the fences of `:::agent`, callouts (with `:::question`), decisions and risks removed, titles and text kept.
- `no-agent-block`: `:::agent` blocks removed.
- `no-doc-context`: `:::agent` blocks outside the selected sections removed, so the "Document-wide agent instructions" block is gone. It does not apply to S2. In `run`, each `read` call with `sections` removes the blocks outside the sections that call asks for; a call for the outline or the whole view reads the source as it is, as the oracle does.

Every rewrite keeps the number of lines, so spans and `[L12]` references stay valid.

Transcripts use one block per call: a `>>> read {"file": ...}` line, then the result. Only the results count as what the model read.

## Mapping spans

Annotators see only `doc.md`, so they record only `md` spans. `map-spans` fills the `smd` span of every annotation item, and the `smd` spans of each edit plan's `expected`, from the `md` spans.

1. `doc.smd` is taken without markup (`withoutMarkup`, the text the similarity number compares) and its `:::include` blocks are written out, as `doc.md` writes them. Every included line remembers its `:::include` line.
2. The non-blank lines of both files are normalised and aligned by their longest common subsequence.
3. An `md` span maps to the first and last `smd` line its aligned lines land on, so fence lines the markup adds inside it are covered. When that span ends on the last line of a container that opens inside it, the container's closing fence is taken in too. Text from an included file maps to its `:::include` block.

It reports items it could not map (no line of the span aligns), items whose evidence is not inside the mapped span, `md` lines with text that no `.smd` line matches, and spans that differ from what the file has. Without `--write` it changes nothing. With `--write` it rewrites `annotations.json` (keys in the order `id, kind, md, smd, evidence, annotator, notes`, one item per line, 2-space indent) and, when an edit plan changed, `tasks.json` (one task field per line). It overwrites `smd` spans that are already there, so read the report first.

The validator stays strict: an item without an `smd` span is an error. `map-spans` reads the annotation files as raw JSON, so it works before the spans exist.

## Agreement

The annotation guide asks a second annotator to annotate a quarter of the documents. Put the two files in each document folder under any names and pass them:

```sh
npm run eval -- agreement research/data/corpus --a annotations.a1.json --b annotations.a2.json --out <dir>
```

Only `md` spans are read, so the files need no `smd` spans. Folders with only one of the two files are listed as skipped.

- **Candidates**: two items whose `doc.md` spans overlap.
- **Matching**: one to one, greedily, best first, by the Jaccard index of the two spans' line sets. Ties go to the higher Jaccard index of the evidence words (the words of each phrase, and the letter-and-digit runs of each regex), then to file order. The guide also asks that matched items state the same claim, which only a person can confirm. An adjudicator's `--pairs` file, `{"<doc>": [["idA", "idB"], …]}`, replaces the automatic matching for the documents it names, with only the confirmed pairs.
- **Item F1**: 2 × matched / (nA + nB), per document and pooled.
- **Kind kappa**: Cohen's kappa on `kind` over matched pairs, (observed − expected) / (1 − expected), with expected agreement from each annotator's own kind shares. It is undefined (reported as `-`, with a note) when there are no matched pairs, or when both annotators gave every matched pair the same single kind.
- **Unmatched items** of each side, with id, kind, span and evidence, and the matched pairs whose kinds differ, for the adjudication. The pooled report adds a confusion table of kinds.

Agreement is reported on the files before adjudication, as the guide says.

## Marker comparison

The guide's marker comparison has a second marker mark a document again from its `doc.md`, without seeing the first marking. Put each re-marked file at `<dir>/<doc>/doc.smd` and run

```sh
npm run eval -- compare-marks research/data/corpus --other <dir> --out <dir>
```

Both markings are placed on `doc.md` lines through the same line alignment `map-spans` uses, so the two `.smd` files may differ in layout. A mark is a container (its name, and `status` for a decision) or a heading marked `{agent=skip}`. `:::include` blocks are left out, because a re-marker cannot know which passages are shared, and so is inline task syntax.

- Two marks **match** when they have the same kind and their `doc.md` spans are within one line at both ends, closest first, one to one. They match **exactly** when their status is the same too.
- **Share** is 2 × exact / (marks A + marks B), per document and pooled.
- The report lists matched marks whose status differs and the marks found by one marker only, and shows the front matter `status` of both.

## Model runs

```sh
npm run eval -- run research/data/corpus --config run.json --out runs/pilot --dry-run
EVAL_MODEL_A_KEY=... npm run eval -- run research/data/corpus --config run.json --out runs/pilot --docs s01-ledger-export-spec --runs 3
npm run eval -- score research/data/corpus runs/pilot/answers.jsonl --out runs/pilot/scores --model model-a
EVAL_MODEL_A_KEY=... npm run eval -- run research/data/corpus --config run.json --out runs/pilot --setup-probe
npm run eval -- tokens runs/pilot --scored runs/pilot/scores/outcomes.json --model model-a
```

`run` sends every (model, task, condition, run) to a model through a Chat Completions-compatible API: `POST {baseUrl}/chat/completions` with `Authorization: Bearer <key>`. Most providers offer one, so the code names none. It uses Node's `fetch` and no other package.

### Config

`run.example.json` is a starting point.

| field | meaning |
|-|-|
| `models[].label` | short name for paths and records (letters, digits, `.`, `_`, `-`) |
| `models[].model` | the provider's pinned model id |
| `models[].baseUrl` | the API root, without `/chat/completions` |
| `models[].apiKeyEnv` | the environment variable that holds the key |
| `models[].maxOutputTokens` | the output limit, the same for every condition (default 1024) |
| `models[].outputLimitField` | the request field for it (default `max_tokens`) |
| `models[].price` | `inputPerMTok` and `outputPerMTok`, for the dry-run estimate only |
| `models[].sendSeed` | send a seed (only for APIs that take one) |
| `models[].extraBody` | other request fields, sent as given |
| `models[].timeoutMs` | per request |
| `runs` | runs per task and condition (default 5) |
| `conditions` | default: all of them, see below |
| `seed` | run n sends `seed × 1000 + n` when the model has `sendSeed` (default 1) |
| `maxToolCalls` | tool calls per answer (default 8) |
| `concurrency`, `retries`, `timeoutMs` | defaults 2, 5 and 120000 |
| `analysis.niMargin` | non-inferiority margin for `score --config`, a share (0.05 is 5 points). Not set by default |
| `analysis.equivalenceMargin` | equivalence margin for `score --config`, a share. Not set by default |
| `analysis.baseline` | the reference condition for `score --config` (default M1) |

The key is read only from the named environment variable. It is never printed, logged or written, and neither is the `Authorization` header; error texts from the provider have the key removed before they are logged. A config with a field named like a secret (`apiKey`, `token`, `headers`, …) is refused. Temperature is never sent, so the provider default applies, as the protocol says, and `extraBody` may not set it or any field the runner sets.

`--docs`, `--tasks`, `--conditions` and `--runs` narrow the config for one invocation, `--limit` caps the new answers, and `--concurrency` overrides the config's.

### Conditions

`M1`, `S1`, `S2`, `S4-brief`, `S4-budget`, `O` and the S2 ablations (`S2.all-audiences`, `S2.plain-blocks`, `S2.no-agent-block`) put the rendered text in the user message, the same text `render` writes. `M2`, `S3` and the S3 ablations (`S3.all-audiences`, `S3.plain-blocks`, `S3.no-agent-block`, `S3.no-doc-context`) give the model only the file name and let it read with the tool. M2 runs `mdRead` on `doc.md`. S3 runs the agent-view `read` the MCP server runs (`readDocument` with the corpus `today` and include reader, plus its note or error for sections that match nothing), on the ablated source for the ablations. The oracle renders (`M2-oracle`, `S3-oracle`) and `M2-outline` stay offline and `run` refuses them.

### The same tool set in every condition

The protocol asks for the same system prompt, tool set size and output limit in every condition. The runner gives every condition exactly one tool, named `read`:

- M conditions get the M2 tool's definition (`MD_READ_DESCRIPTION`, `MD_READ_SCHEMA`), S conditions the MCP `read` tool's own description and schema, taken from the server's tool list.
- In M2 and S3 the tool reads. In the whole-text conditions it is inert: every call returns "The whole document is already in the message. This tool has nothing more to give."

So M1 and M2 send the same tool definition, and S1, S2, S4, O and S3 send the same one; the conditions of one format differ only in the user message and in what the tool does. The trade-off: an inert tool can draw a few wasted calls in whole-text conditions, and its definition costs tokens that buy nothing there. Both are measured, not hidden: the calls are in `toolCalls` and the transcript, and their tokens are in the provider usage. The M and S tool definitions differ slightly in size (M2 has `query` and `lines`, MCP `read` has `brief`), which the provider usage also shows. A single answer tool everywhere would have added a second tool to M2 and S3 and changed how every condition answers, so the answer is plain text instead.

The system prompt is one fixed text for every condition and task (`SYSTEM_PROMPT` in `prompts.ts`). The user message holds the task, the answer format for its type and, in whole-text conditions, the document between `<document>` and `</document>`.

### Answers

The model ends with one JSON object, in the format the user message gives for the task type:

| type | format |
|-|-|
| `fact-lookup` | `{"text": "…", "lines": [[start, end]]}` |
| `constraint-check` | `{"verdict": "yes" or "no", "lines": [[start, end]]}` (the span of the rule) |
| `decision-status` | `{"option": "…", "lines": [[start, end]]}` |
| `open-question` | `{"undecided": true or false, "fallback": "…", "lines": [[start, end]]}` |
| `qualification` | `{"text": "…"}` |
| `edit-plan` | `{"lines": [[start, end], …]}` |

Line numbers are lines of the file the condition shows: `doc.md` for M conditions, `doc.smd` for the rest, as the scorer expects. The runner takes the last JSON object in the final text, fenced or bare, with any text around it. `lines` may also be one span or single line numbers. When no JSON object is found, the raw text is recorded as the answer with `"error": "parse"`. A model that keeps calling the tool is told the limit is reached after `maxToolCalls` calls; if it calls again the answer is recorded empty with `"error": "tool-limit"`. Both are scored as given, so they count as wrong rather than going missing.

The model cannot know annotation ids, so constraint checks are cited by line span. The whole-text conditions show the file without line numbers (the text `render` writes), so in M1 and S1 the model has to count lines; agent views and the M2 heading list carry line references.

### Output

- `<out>/answers.jsonl`: one `AnswerRecord` per answer, with `doc`, `model` as `<label>:<model id>`, `seed` when one was sent, `usage` (the provider's numbers summed over the requests of the answer, nested ones flattened as `prompt_tokens_details.cached_tokens`, plus `requests`), and `toolCalls`.
- `<out>/transcripts/<label>/<task>/<condition>/run-<n>.json`: the request settings, every message, every tool call with its arguments and result, each response's id, model, fingerprint, finish reason, usage, attempts, failed attempts (`failures`: status, error and time of each attempt that was retried) and latency, and the parsed record. Never the key.
- `<out>/transcripts/<label>/<task>/<condition>/run-<n>.failed-<k>.json`: an answer that failed, with every request it made before the failure and their usage, then one `"failed": true` entry with the failed request's attempts. Each failure gets the next free `k`, so a later retry of the job never overwrites what an earlier try spent.
- `<out>/run-manifest.json`: the corpus, the config (it holds no secrets), the settings, the system prompt, both tool definitions, notes on the design, and one entry per invocation with the date, the tool's commit and whether its tree had changes, the extension version, the Node version, the filters and the counts.
- `<out>/errors.jsonl`: answers that failed (an HTTP error, a response without a message, retries used up), with the usage of the requests made before the failure and the path of the failed transcript. A failed answer is not written to `answers.jsonl`.
- `<out>/setup.jsonl`: one row per setup probe (see [Token accounting](#token-accounting)).

The run resumes: an answer already in `answers.jsonl` (same model, document, task, condition and run) is skipped, so running the same command again fills only what is missing, including failed answers. Requests run `concurrency` at a time. 408, 409, 429, 5xx, timeouts and network errors are retried up to `retries` times, after the server's `Retry-After` or 1, 2, 4, … up to 32 seconds.

`--dry-run` sends nothing and reads no key. It prints the number of requests per model and condition, the estimated input tokens (characters / 4, labelled as estimates) and, with `price`, an estimated cost range. For M2 and S3 the estimate covers the first request only, and every later request repeats the conversation, so their tokens and cost are labelled lower bounds. It writes `dry-run/plan.json` and the first request body of each model and condition to `dry-run/<label>/`, without the `Authorization` header.

## Token accounting

`tokens` follows `research/token-accounting.smd`. It reads a run folder and sends nothing.

```sh
npm run eval -- tokens <run dir> [--out <dir>] [--scored outcomes.json] [--model <label>] [--seed 1] [--resamples 2000] [--baseline M1] [--json]
```

Each request of each transcript, answered or failed, becomes one call record with a class:

| class | the request |
|-|-|
| `retrieval` | asks for a read |
| `repeat-read` | asks only for reads the episode already made (same tool and arguments, key order ignored) |
| `repair` | comes after a tool result that was an error (`Error: …`) or a view over its budget (`[budget: …, required content does not fit]`) |
| `answer` | gives the final text |
| `retry` | a failed attempt that was retried or ended the answer, logged with no usage when the provider billed nothing |

Usage is mapped from the provider's own fields, which stay in `usage_raw`: Chat Completions (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`) or `input_tokens` APIs (`input_tokens`, `output_tokens`, cache fields inside `input_tokens_details` or beside it as `cache_read_input_tokens` and `cache_creation_input_tokens`). `input` always includes cached input: cache fields reported beside `input_tokens` are added to it. A usage shape it does not know is counted as `unmapped`.

The total is input plus output, with cached input counted as ordinary input. Uncached input, cache reads, cache writes, output and reasoning tokens are reported beside it, never folded into another number. Per model and condition, `tokens` reports answered and failed episodes, the median and quartiles of the total per answered episode, its mean with the scorer's paired bootstrap interval and the difference from the baseline (M1 when present), the tokens failed episodes spent, the share of tokens per call class, and the numbers of calls, repair calls, repeat reads and retries. With `--scored` (the scorer's `outcomes.json`) it puts mean correctness beside the tokens, and `by-task.csv` gives tokens and correctness per task. They are never combined into one score.

`run --setup-probe` measures the fixed part of every request: one request per model and tool definition (the M tool for M conditions, MCP `read` for S conditions) with the system prompt, the tool and a one-line message, appended to `setup.jsonl`. `tokens` then reports the setup input per request and its share of all input. The probe's own message is a few tokens, given as `probeMessageEstimate`.

`tokens` writes `calls.jsonl`, `episodes.jsonl`, `tokens.json`, `tokens.md` and `by-task.csv` to `<run dir>/tokens/`, or to `--out`.

## Evidence survival check

For each condition and item, `check` asks whether all of the item's evidence appears in what the condition shows. It is a deterministic projection check with no model. It is not task accuracy. An item can be shown and still be misread, and a phrase that appears twice counts wherever it appears.

## Scoring

Answers are JSON lines:

```json
{"task": "wh-02", "condition": "S2", "run": 1, "seed": 7, "model": "model-id",
 "answer": {"verdict": "no"}, "cited": ["https-only"], "lines": [[18, 18]],
 "usage": {"input_tokens": 380, "output_tokens": 4}}
```

`answer` is a string or an object with `text`, `verdict`, `option`, `undecided` and `fallback`, or `lines`. Add `doc` only if task ids repeat (`run` always adds it). `toolCalls` and `error`, which `run` adds, are not scored. Conditions whose id starts with `M` use `doc.md` line numbers. The rest use `doc.smd`.

Per-task outcomes go to `outcomes.json` and `outcomes.csv`. Per condition, `summary.md` reports correctness, the difference from the baseline, constraint violations and use of superseded options, each with a 95% interval from a seeded paired bootstrap. Each resample draws documents with replacement, then tasks within each drawn document, and uses the same draws for every condition. A unit is a (document, task) pair, scored as the mean over its runs.

Provider token counts (`usage`) and estimates (characters / 4) are kept in separate fields and columns. `shownTokensEstimate` is only filled for conditions the renderer can reproduce.

### Non-inferiority and equivalence

H1 is a non-inferiority claim, and equivalence is a different claim, so the scorer reports them apart. Both use the correctness difference against the baseline (condition minus baseline, higher is better) and its paired bootstrap 95% interval, the same interval as the `vs M1` column, which stays as it was.

| verdict | non-inferiority, margin m | equivalence, margin m |
|-|-|-|
| holds | lower bound above -m: `non-inferior` | interval inside (-m, m): `equivalent` |
| fails | upper bound below -m: `inferior` | interval wholly below -m or above m: `not-equivalent` |
| neither | the interval holds -m: `inconclusive` | otherwise: `inconclusive` |

The 95% interval makes each one-sided test a 2.5% test, as the protocol says. Equivalence uses the same interval for both one-sided tests, which is stricter than the usual 90% interval.

No margin is set by default, and then no verdict is given. The study owner sets the margins after the pilot, with `--ni-margin` and `--eq-margin`, or with `analysis.niMargin` and `analysis.equivalenceMargin` in a run config passed with `--config`. Flags win over the config. A margin is a share between 0 and 1. The verdicts are in `summary.json` (`nonInferiority`, `equivalence`) and in their own table in `summary.md`, and the settings record the margins used, null when none was.

### Sample size and power

`power` sizes the main run by simulation, as the protocol asks, before the pilot with planning values and after it with the pilot's estimates. It sends nothing anywhere and is deterministic for a seed (each row has its own stream, so a row does not change when the grid does).

```sh
npm run eval -- power --ni-margin 0.05 --diff 0 --docs 12,24,36 --tasks 10,25 --runs 5
npm run eval -- power --diff -0.1 --docs 24 --tasks 25 --runs 5        # power to see a 10-point difference
npm run eval -- power --pilot out/pilot/outcomes.json --reference M1 --condition S3 --ni-margin 0.05 --runs 5
```

The outcome model is logit-normal with tasks nested in documents. Each (document, task) unit is answered `--runs` times under the reference and the comparison, and its score is the mean of its answers, as in the scorer.

```
logit P(correct) = beta_c + u_dc + v_dtc
u_dc ~ N(0, su2), corr(u_d0, u_d1) = doc corr      (document effect)
v_dtc ~ N(0, sv2), corr(v_dt0, v_dt1) = task corr  (task effect)
```

| flag | meaning | default |
|-|-|-|
| `--accuracy` | marginal correctness under the reference | 0.8, or the pilot's |
| `--diff` | true marginal difference, comparison minus reference | 0 |
| `--ni-margin`, `--eq-margin` | margins, as in `score`. Without them only the difference column is filled | not set |
| `--docs`, `--tasks` | the grid: documents, and tasks per document (comma lists) | 12,24,36 and 10 |
| `--runs` | answers per unit and condition | 1 |
| `--icc` | latent-scale share of variance between documents | 0.1, or the pilot's |
| `--task-icc` | latent-scale share between tasks within a document (icc + task icc < 1, the rest is the logistic residual pi^2/3) | 0.3 |
| `--doc-corr`, `--task-corr` | how alike a document's, or a task's, effect is under the two conditions. At 1 the effect cancels in the paired difference | 0.5 and 0.5 |
| `--alpha` | one-sided level of each test; the interval is the two-sided 1 - 2 alpha one | 0.025 (the scorer's 95%) |
| `--sims`, `--seed` | simulated data sets per row, and the seed | 1000 and 1 |
| `--method` | how each data set is analysed, see below | `scorer` |

The defaults are placeholders for planning, not estimates. The intercepts are set by quadrature so the marginal accuracies are exactly `accuracy` and `accuracy + diff`. Every simulated data set is analysed with the scorer's own interval, and power is the share of data sets that are non-inferior (lower bound above -margin), equivalent (inside the margins) or show a difference (the interval excludes 0). At `--diff 0` the difference column is the false positive rate. Each cell has its Monte Carlo standard error.

Methods:

- `scorer` (default) is a normal approximation with the exact variance of the scorer's two-stage bootstrap distribution, so it costs no resampling. For D documents, S_d the sum of a document's differences, n_d its tasks, w_d the variance of its differences and m the mean difference, the bootstrap variance of the mean is `[ (1/D) sum (S_d - m n_d)^2 + (1/D) sum n_d w_d ] / (D nbar^2)`.
- `bootstrap` runs the scorer's `pairedBootstrap` on every data set. It is slow and is there to check `scorer`. On 400 data sets per setting the two agreed within Monte Carlo error: 12 documents by 10 tasks at a difference of -0.05 and a margin of 0.05 gave 0.020 and 0.018, and mean half-widths 0.142 and 0.141. 24 by 10 with 5 runs at 0 gave 0.343 and 0.350 (0.061 both). 8 by 25 with icc 0.3 and 3 runs at -0.1 gave a difference power of 0.343 and 0.380 (0.134 and 0.133). The unit tests check the intervals agree within 0.015 on simulated data.
- `cluster` is a one-stage cluster-robust interval with documents as clusters, the D / (D - 1) correction and t with D - 1 degrees of freedom. It holds its nominal level: at the margin boundary (difference -0.05, margin 0.05, 24 by 10, default model) its non-inferiority power was 0.028 against 0.025 on 4000 data sets.

The scorer's two-stage bootstrap is conservative. Drawing tasks again inside each drawn document counts within-document variance on top of the between-document variance that already holds it. In the boundary case above it rejected 0.8% of the time, not 2.5%, and its intervals were about a fifth wider than `cluster`'s. With few documents (8) the order turns, since `cluster` uses t with 7 degrees of freedom. So `scorer` gives the power of the analysis the scorer reports, and `cluster` shows what a calibrated interval would give. Which interval the confirmatory analysis uses is the study owner's decision.

`--pilot` reads a scored pilot (`outcomes.json` from `score`) and estimates the reference's accuracy and the one-way ANOVA intra-class correlation of its unit scores within documents. The observed ICC is converted to the model's latent icc by quadrature at the given task icc and the pilot's runs per unit. They replace `--accuracy` and `--icc` unless those flags are given. `--condition` also reports the pilot's observed difference, as a description only, since pilot data is not part of the confirmatory analysis. Answers waiting for a judge are left out. The task icc and the two correlations are not estimated, so set them from the pilot by hand or keep the planning values.

### Judge packets

Qualification answers are written to `judge-packets.jsonl` in a seeded random order. A packet holds the task, the rubric, the annotated items as plain Markdown text, and the answer. It never holds the condition. `judge-key.jsonl` maps packet ids back to answers. Keep it away from judges. Pass the judgements back with `--judged`, one line per packet: `{"packet": "9e64247cc329", "correct": 1, "violation": false}`. `correct` must be 0 to 1. `--judged` takes several files separated by commas. For a packet in more than one, the last file wins, so list the judge's file first and people's rescoring after it.

### Model judge

The protocol scores open answers with a model judge that never sees the condition, has a person score a random 15% blind, and has people rescore any task where the two disagree on more than a fifth of its answers. Three commands do this, after `score` has written `judge-packets.jsonl`.

```sh
npm run eval -- judge out/score/judge-packets.jsonl --config run.json --model judge-a --out out/judge --dry-run
npm run eval -- judge out/score/judge-packets.jsonl --config run.json --model judge-a --out out/judge
npm run eval -- sample out/score/judge-packets.jsonl --out out/human --share 0.15
npm run eval -- judge-agreement out/score/judge-packets.jsonl --judged out/judge/judged.jsonl --human out/human/human.jsonl --out out/agree
npm run eval -- score ../research/data/corpus out/run/answers.jsonl --out out/final --judged out/judge/judged.jsonl,out/human/human.jsonl,out/agree/rescored.jsonl
```

- `judge` sends each packet to one model from a run config (the same format as `run`; pick it with `--model` when the config lists several). The judge gets a fixed system prompt, the question, the rubric, the annotated passages and the answer, and no tool. It must give `true` or `false` for every rubric criterion and for `violation`. `correct` is the share of criteria met, worked out by the harness, not taken from the judge. Verdicts go to `judged.jsonl`, which `score --judged` reads. A reply that is not valid, or a failed request, goes to `judge-errors.jsonl` and is tried again on the next call, and packets already in `judged.jsonl` are skipped. Every request is kept in `judge-transcripts/`. `--dry-run` sends nothing, reads no key, and writes the first request and a cost estimate to `judge-dry-run/`.
- `sample` draws the packets people score blind, with a seed. `--share 0.15` (the default) draws within each task: at least one answer of every task, then 15% of its answers rounded up, so every task can be checked against the rescoring rule. `--count 50` draws 50 packets at random, for the check on 50 hand-scored answers before the main run. It writes `human-packets.jsonl` and `human-sheet.md`, a sheet a person can score from. People write their scores as JSON lines in the same shape as `judged.jsonl`.
- `judge-agreement` compares judge and people on the packets both scored. An answer passes when `correct` is at least 0.5. A disagreement is a different pass or fail, or a different violation verdict. The report gives pass/fail and violation agreement with Cohen's kappa, the mean difference in `correct`, and how the judge-minus-human difference moves with answer length, since judges can favour long answers. Tasks with disagreements on more than 20% of their sampled answers are listed for rescoring, and with `--out` every packet of those tasks goes to `rescore-packets.jsonl` and `rescore-sheet.md`.

`judge-key.jsonl` is never an input to these commands. Keep it away from the judge and from the people scoring.
