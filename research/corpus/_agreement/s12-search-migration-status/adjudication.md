# Adjudication: s12-search-migration-status

Adjudicator ai-adjudicator-a, guide research/annotation-guide.smd 0.2.

Counts: a1 48 items, a2 63 items, 46 pairs, 70 resolved items. Kind disagreements within pairs: 3 (no-reindex-in-freeze constraint/negation, gates-green-three-days constraint/limit, freshness-14-days-past-25 / hold-25-until-14-green-days constraint/limit).

## Dropped

- None. Both unmatched a1 items and all 17 unmatched a2 items meet the guide's item definition.

## Kind decisions

- no-reindex-in-freeze: constraint (a1). It forbids an action. a2's evidence also held the exception, which a1 kept as damaged-index-reindex-exception.
- gates-green-three-days: limit (a2). The rule is bounded by a count of days, and limit is the more specific kind.
- hold-25-until-14-green-days: limit (a2), same reason.

## Changes

- preorder-index-exception (a1): split. Evidence trimmed to "The exception is pre-orders". The rule became the new item unsold-editions-not-indexed. Both annotators had rule and exception in one item.
- folio-query-logs-not-copied (a2): split. Evidence trimmed to the rule. The sample exception became folio-query-sample-exception.
- ranking-score-drop-limit: kept a1 with one claim. a2's bundled exception is a1's separate item score-drop-written-exception.
- a11y-keyboard-screen-reader: added, prose-only requirement on line 289, missed by both.
- no-new-folio-projects: added, "Nobody should start a new project on it" on line 485, missed by both.
- trade-customers-emailed-exception: added, exception to no-shopper-announcement on line 619, missed by both.
- autocomplete-exclusions (a1) paired with autocomplete-no-content-warning (a2). Kept a1, which covers the whole exclusion rule.
- No span of a kept item was changed.
