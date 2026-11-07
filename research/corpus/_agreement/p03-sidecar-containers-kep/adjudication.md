# Adjudication: p03-sidecar-containers-kep

Adjudicator ai-adjudicator-a, guide research/annotation-guide.smd 0.2.

Counts: a1 45 items, a2 49 items, 42 pairs, 52 resolved items. Kind disagreements within pairs: 5 (always-only-value constraint/negation, no-block-pod-completion fact/negation, collection-name decision-status/open-question, ordering-needs-prestop-in-grace negation/constraint, disable-needs-kubelet-restart fact/constraint).

## Dropped

- a2 feature-gate-name (line 3): the same claim as feature-gate-components (lines 1019-1025, "Feature gate name: SidecarContainers"). One item per claim is enough.

## Kind decisions

- always-only-value: constraint (a1). It restricts accepted values like restartpolicy-init-only on the line before.
- sidecars-not-block-completion: negation (a2). It says what sidecars do not do, and negation is more specific than fact.
- collection-name-open: open-question (a2). The infrastructureContainers alternative is postponed, not rejected, and initContainers is the interim choice.
- ordering-needs-prestop-in-grace: negation (a1). It limits a guarantee and does not tell anyone what to do.
- disable-needs-kubelet-restart: constraint. Kept a1's item and changed its kind from fact, because disabling needs an operator step.

## Changes

- collection-name-open (a2): evidence "infrastructureContainers" replaced by a1's tighter "new collection infrastructureContainers".
- recreate-pods-on-disable: added by splitting a2's disable-needs-kubelet-restart, which bundled the recreate rule with the kubelet restart.
- rollback-metric keeps a checker warning: the metric name repeats at line 1161, as its notes record.
- init-restartpolicy-unset-default and no-always-to-never-override (a2) are kept, with notes that they describe possible future semantics, not shipped behaviour.
- No other span, kind or evidence of a kept item was changed.
