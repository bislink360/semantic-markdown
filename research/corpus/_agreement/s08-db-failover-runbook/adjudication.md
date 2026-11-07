# Adjudication: s08-db-failover-runbook

Adjudicator ai-adjudicator-a, guide research/annotation-guide.smd 0.2.

Counts: a1 38 items, a2 43 items, 32 pairs, 53 resolved items. Kind disagreements within pairs: 2 (kfail-retired, no-detach-b-or-c, both constraint in a1 and negation in a2).

## Dropped

- None. All 6 unmatched a1 items and all 11 unmatched a2 items meet the guide's item definition.

## Kind decisions

- kfail-retired: constraint (a1). "Should not be used" forbids an action, which is the guide's constraint definition. Negation is for "not the case", "not supported" or an exception.
- no-detach-b-or-c: constraint (a1), same reason.

## Changes

- lease-anomaly-escalate (a2): added evidence "stop what you are doing" so the item shows the action, not only the condition.
- never-restart-old-primary: kept a1 with one claim. "Never remove its fence by hand" became its own item never-unfence-by-hand.
- bot-quote-step: added, prose-only rule for automated tools on line 15, missed by both.
- alert-order: added, "handle the one higher in the table first" on line 85, missed by both.
- rebuild-working-hours: added, prose-only constraint with exception on line 221, missed by both.
- c-only-if-b-down (a1) and manual-lag-limit-c (a2) share line 142 but state different claims, so they are not paired and both are kept.
- No span or kind of a kept item was changed.
