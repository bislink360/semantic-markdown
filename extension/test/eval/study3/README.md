# Study 3 loop fixture

This folder drives `test/study3Loop.test.ts`, an offline run of the whole feedback loop Study 3 will observe. It tests the tooling and is not study data. The tool's developers wrote the document, the agent's actions and the person's answers. No model and no participant took part. The Study 3 protocol and its human pilot are not drafted, so the measure names below are working names for what the tooling can already record, not the study's final measures.

It lives here and not in `../fixture/`, because that folder is a corpus and every folder in it is read as a corpus document.

## Files

- `spec.smd` is the starting document. R1 says a failed webhook delivery is retried up to 5 times, AC1 verifies it, T1 and T2 are checked, and the Evidence section is empty.
- `retry.json` is the code under change, the retry policy the service reads. It starts by retrying both 4xx and 5xx responses.
- `script.json` holds what the scripted agent and the scripted person write, and the dates of each step.
- `expected-measures.json` is the record the run must produce.

## How it runs

The test copies `spec.smd` and `retry.json` into a temporary Git repository and commits each step with fixed names and dates, so commit hashes are the same on every run. A scripted agent stands in for the model, as the runner tests use a scripted provider. It reads through the agent view, keeps the revision it read as its checkpoint, and follows fixed rules. The verification is a pure function standing in for the project's tests. It checks `retry.json` against what R1 says now. Every step goes through the commands a participant would use, `smd review`, `smd updates`, `smd rev`, the trace and the agent view, so the run checks those together.

| Step | What happens | Tooling exercised | Measure it supports |
|-|-|-|-|
| 0. Baseline | The agent verifies the shipped policy and records `:::evidence{#E1 result=pass rev=R1@… commit=…}` | `smd rev`, evidence records, `smd trace` | Verification tied to the revision and commit it checked (AF26) |
| 1. Uncertainty | R1 does not say whether a 4xx counts as failed, so the agent adds `:::question{#Q1}`, a task T3 that depends on it, and a suggestion that guesses the answer | Source edit, `smd review suggest`, `question[status=open]` | Uncertainty raised by the agent (`uncertaintyRaised`, AF31 attention detection) |
| 2. Human response | The person answers Q1 (`smd review answer`), rejects the guess with a reason (`smd review reject`) and unchecks T1 | `smd review` transitions with `by=` and `on=` | Explicit human transitions, never inferred (AF09) |
| 3. Retrieval | The agent asks what changed since its checkpoint, as `rev:` and as a commit. It gets Q1 answered, with T3 as affected, the rejection, and T1 reopened, without the answer's text replayed, and reads the answer in the agent view. Nothing is written | `smd updates --since`, agent view | Feedback retrieval kept apart from incorporation (`answerRetrieved`, `rejectionRetrieved`, `reopenRetrieved`, AF22), human-answer context cost (AF33) |
| 4. Incorporation | The agent proposes R1's new text as a suggestion. It changes nothing until the person accepts it and sets Q1 to incorporated. R1's revision changes, so E1 is outdated: `evidence/stale` warns, the trace counts it as outdated, not passing, and the agent view marks it OUTDATED | `smd review suggest/accept/incorporate`, `smd rev`, validator, `smd trace`, `agent --evidence` | Feedback incorporation with human confirmation (`answerIncorporated`, `incorporationConfirmedBy`, AF09, AF32). The rejected guess never reaches R1 (`rejectedSuggestionApplied`, stale-decision use). Stale verification flagged (`staleEvidenceFlagged`, AF28) |
| 5. Code change and verification | The agent changes `retry.json` and forgets 429, so the check fails and E2 records it. The fix passes and E3 records it, each with R1's new revision and the commit it ran on. T1 is checked again and T3 is checked | Evidence records, `smd trace`, validator | Falsely accepted completion (`falselyAcceptedCompletion`: no outdated or failing record ever counts as passing), re-verification after the change (`reverifiedAfterChange`, AF26, AF28, AF32) |
| 6. Catch-up | From its checkpoint the agent gets the net dispositions: Q1 incorporated, R1 changed, the rejection, E2 and E3 added, T3 checked. T1 was checked at the checkpoint and is again, so it is not listed | `smd updates --since` | Revision-aware retrieval over a whole loop (AF22) |

E1 stays in the document as history and keeps its `evidence/stale` warning, as AF28 asks: it is never shown as a current verified outcome, and a person may update its `rev` only after rechecking.

## What the measures mean

| Field | Meaning in the run |
|-|-|
| `uncertaintyRaised` | the agent's rule found the gap in R1 and it asked instead of guessing silently |
| `answerRetrieved`, `rejectionRetrieved`, `reopenRetrieved` | `smd updates` since the agent's checkpoint reported each disposition |
| `rejectedSuggestionApplied` | R1 ever contained the rejected guess (should be false) |
| `answerIncorporated` | Q1 is incorporated and R1 carries the answer's rule |
| `incorporationConfirmedBy` | who accepted the change to R1 (a person, not the agent) |
| `staleEvidenceFlagged` | after R1 changed, E1 was outdated and flagged |
| `falselyAcceptedCompletion` | an outdated or failing record counted as current passing evidence after R1 changed (should be false) |
| `verificationRuns`, `failedVerifications` | verification runs recorded as evidence, and how many failed |
| `reverifiedAfterChange` | the passing record names R1's new revision |

Not covered here: timing, workload and confidence (AF31), token counts (AF33, no model is called), and any participant. Those belong to the Study 3 protocol and its pilot.
