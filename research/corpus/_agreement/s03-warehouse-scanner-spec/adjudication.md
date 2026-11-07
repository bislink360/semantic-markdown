# Adjudication: s03-warehouse-scanner-spec

Adjudicator ai-adjudicator-a, guide research/annotation-guide.smd 0.2.

Counts: a1 45 items, a2 78 items, 42 pairs, 95 resolved items. Kind disagreements within pairs: 5 (agency-never-leads negation/constraint, truck-no-partial-multi-carton constraint/negation, no-signout-with-queue negation/constraint, reference-data-24h constraint/limit, rollout-freeze negation/constraint).

## Dropped

- None. All 3 unmatched a1 items and all 36 unmatched a2 items meet the guide's item definition.

## Kind decisions

- agency-never-leads: negation (a1). The sentence says what agency staff are not, and the guide prefers negation over constraint.
- truck-no-partial-multi-carton: constraint (a1). It forbids an action under a stated condition.
- no-signout-with-queue: constraint (a2), same reason. Its exception became its own item.
- stale-reference-data-24h: limit (a2). The rule is bounded by a time.
- go-live-blackout: constraint (a2). It forbids go-lives in a window.

## Changes

- cradle-signout-exception: added, the charging cradle exception on line 318 was only in a1's notes.
- log-retention (a2): split. Evidence trimmed to the 400 day scan log. The 30 day application log limit became app-logs-30-days.
- rollout-spacing-poznan-last (a2): split. Evidence trimmed to "Poznań goes last". The 3 week spacing became rollout-3-weeks-apart.
- Added because neither annotator listed these prose-only constraints: text-9mm-high (line 94), portrait-only (96), pin-never-shown (110), one-list-until-dropped (196), lead-no-direct-wms-changes (484), security-review-before-pilot (525), colour-not-only-signal (537), r4-week-in-test-area (595), no-merge-failing-test (603), no-real-data-in-tests (613), rates-never-per-person (668).
- Kept a2 over a1 where a2's evidence was tighter or a1's notes bundled a claim that a2 listed separately: feedback-cannot-be-off, multi-carton-all-or-nothing.
- Many numeric limits stated only once in the document (API rate limit, timeouts, token lifetime, move and grading sizes) were listed by neither annotator. They are not decisions, open questions or constraints, so they were not added.
- No span of a kept item was changed.
