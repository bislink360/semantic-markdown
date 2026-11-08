# Adjudication: p12-rust-goals-2025h1

Adjudicator ai-adjudicator-a, guide research/annotation-guide.smd 0.2.

Counts: a1 44 items, a2 48 items, 33 pairs, 59 resolved items. Kind disagreements within pairs: 1 (astv2-not-stabilized / arbitrary-self-types-pending, negation in a1 and fact in a2).

## Dropped

- None. All 11 unmatched a1 items and all 15 unmatched a2 items meet the guide's item definition.

## Kind decisions

- astv2-not-stabilized: negation (a1). It says something is not yet the case, and negation is more specific than fact.

## Changes

- goal-count-40 (a1) paired with goal-slate-accepted (a2). Kept a1, which holds the count only. The acceptance is a1's separate item rfc-3764-accepted.
- abi-flags-z-to-c: kept a1, which holds one claim. a2 also bundled the RFC's PFCP status.
- async-contact (a2, line 106) and async-owner-tmandry (a1, line 186) are both kept. Their spans do not overlap, and one names the goal contact while the other names the overall owner.
- No items added. The superseded dependency-information plan, the rejected shiny-future approach and the open questions (pin syntax, build-std patching, maintenance team) already have items. The prose design axioms are mostly aims, not rules.
- No span, kind or evidence of a kept item was changed.
