# Harness fixture

This folder tests the evaluation harness. It is not study data.

The tool's developers wrote these documents, annotations, tasks and answers to exercise the code. Nobody annotated them independently, and the tasks were written with the tool in view. Never use them as study data, in a pilot, or as examples of the annotation guide.

- `webhooks/` has a constraint, a negation with an exception, limits, an accepted and a superseded decision, an open question with a fallback, an `:::agent` block above the first heading, a `:::human` block and a section marked `{agent=skip}`.
- `pagination/` is a short ADR with a rejected option, a limit, a negation and an open question.
- `answers.jsonl` holds made-up answers for two conditions. No model wrote them.

The Study 3 loop fixture is in `../study3/`, outside this folder, because every folder here is read as a corpus document.

Run the harness on it from `extension/`:

```sh
npm run eval -- validate test/eval/fixture
npm run eval -- check test/eval/fixture
npm run eval -- score test/eval/fixture test/eval/fixture/answers.jsonl --out <dir>
```
