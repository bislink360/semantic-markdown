# Adjudication: s07-cert-rotation-runbook

Adjudicator ai-adjudicator-a, guide research/docs/annotation-guide.smd 0.2.

Counts: a1 20 items, a2 21 items, 19 pairs, 26 resolved items. No kind disagreements within pairs.

## Dropped

- None. Every unmatched item meets the guide's item definition.

## Kept unmatched

- a1 automation-inventory-only: rule for the rotation bot, prose only.
- a2 sandbox-wildcard-out-of-scope: the exception to the no-wildcard rule is a second claim on line 22.
- a2 internal-api-on-internal-ca: the one hostname left on the internal CA after the ACME decision.

## Changes

- leak-rotate-any-time: kept a1, which holds one claim. a2's second evidence ("tell the security on-call") became its own item.
- leak-tell-security-first: added, prose-only constraint on line 11.
- health-watch-5-minutes: added, 5-minute watch after each pair on line 48, missed by both.
- leak-change-board-after: added, the change-board exception on line 63 was only in a1's notes.
- leak-record-three-times: added, prose-only constraint on line 67, missed by both.
- No span, kind or evidence of a kept item was changed.
