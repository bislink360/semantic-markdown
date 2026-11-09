# Inter-annotator agreement

Corpus research/corpus/_agreement. A = `annotations.a1.json`, B = `annotations.a2.json`, adjudicated pairs from `research/corpus/_agreement/pairs.json`.
Automatic matching: items whose doc.md spans overlap, one to one, greedily by line Jaccard, then evidence-word Jaccard. A person still confirms that each pair states the same claim.
F1 = 2 × matched / (nA + nB). Kappa: Cohen's kappa on kinds over matched pairs.

| document | matching | nA | nB | matched | item F1 | kind kappa | observed | expected |
|-|-|-|-|-|-|-|-|-|
| p03-sidecar-containers-kep | pairs | 45 | 49 | 42 | 0.894 | 0.850 | 0.881 | 0.207 |
| p12-rust-goals-2025h1 | pairs | 44 | 48 | 33 | 0.717 | 0.955 | 0.970 | 0.324 |
| s03-warehouse-scanner-spec | pairs | 45 | 78 | 42 | 0.683 | 0.826 | 0.881 | 0.317 |
| s07-cert-rotation-runbook | pairs | 20 | 21 | 19 | 0.927 | 1.000 | 1.000 | 0.258 |
| s08-db-failover-runbook | pairs | 38 | 43 | 32 | 0.790 | 0.908 | 0.938 | 0.318 |
| s12-search-migration-status | pairs | 48 | 63 | 46 | 0.829 | 0.912 | 0.935 | 0.261 |
| **pooled** | | 240 | 302 | 214 | 0.790 | 0.905 | 0.925 | 0.213 |

## Kinds of matched pairs (rows A, columns B)

| A \ B | fact | constraint | negation | limit | decision-status | open-question |
|-|-|-|-|-|-|-|
| fact | 27 | 1 | 1 | 0 | 0 | 0 |
| constraint | 0 | 64 | 5 | 3 | 0 | 0 |
| negation | 1 | 4 | 38 | 0 | 0 | 0 |
| limit | 0 | 0 | 0 | 37 | 0 | 0 |
| decision-status | 0 | 0 | 0 | 0 | 22 | 1 |
| open-question | 0 | 0 | 0 | 0 | 0 | 10 |

## p03-sidecar-containers-kep

Matched with different kinds:
- always-only-value (constraint) / restartpolicy-only-always (negation)
- no-block-pod-completion (fact) / sidecars-not-block-completion (negation)
- collection-name-initcontainers (decision-status) / collection-name-open (open-question)
- ordering-needs-prestop-in-grace (negation) / prestop-within-grace (constraint)
- disable-needs-kubelet-restart (fact) / disable-needs-kubelet-restart (constraint)

Unmatched in A (3):
- sidecar-readiness-counts (fact) L198-199: "Readiness probes of sidecars will contribute to determine the whole Pod readiness"
- ambient-field-alternative (decision-status) L255-261: "introduce a new field: ambient: true on all containers", "typically controlled by restartPolicy"
- scheduler-gate-off-rejects (fact) L659-660: "will not be admitted as validation of the new field will fail"

Unmatched in B (7):
- feature-gate-name (fact) L3-3: "Feature gate: SidecarContainers"
- prestop-at-termination-start (fact) L714-716: "This happens at the same time as regular containers"
- cp-gate-off-cannot-schedule (fact) L1006-1007: "users will not be able to schedule Pods with the new field"
- slo-init-error-rate (limit) L1147-1148: "error rate for containers of type init_container should be less than 1%"
- slo-tgps-events (limit) L1149-1150: "should be less than 10 per day"
- init-restartpolicy-unset-default (fact) L1268-1270: "the pod's restartPolicy is used to determine the init container restart policy", "For Always, OnFailure is used"
- no-always-to-never-override (constraint) L1275-1277: "An override from Always to Never will not be allowed"


## p12-rust-goals-2025h1

Matched with different kinds:
- astv2-not-stabilized (negation) / arbitrary-self-types-pending (fact)

Unmatched in A (11):
- rfc-3764-accepted (fact) L3-3: "[RFC #3764] has been accepted"
- flagship-chosen-by-roadmap-owner (fact) L33-33: "selected by the roadmap owner as flagship goals"
- design-meeting-no-decision (negation) L88-88: "(no decision expected)"
- async-owner-tmandry (fact) L186-186: "The overall owner of the effort is @tmandry"
- rtn-type-position-deferred-h2 (fact) L161-163: "In H2 we hope to tackle the following", "RTN in type position"
- sync-generators-first (fact) L266-266: "closest to ratifying an RFC for synchronous generators"
- std-rebuild-not-supported (negation) L331-331: "Currently building the standard library with rustc is not supported"
- clippy-policy-correct (fact) L398-398: "the relevant policy is already correct, but documentation is needed"
- build-std-nightly-only (negation) L466-466: "Today it can only be used from a nightly toolchain"
- dynosaur-0-3-candidate (fact) L844-844: "plan to use as a 1.0 candidate"
- crate-attr-rfc-new-owner (fact) L989-989: "is looking for a new owner"

Unmatched in B (15):
- async-contact (fact) L106-106: "Contact | @tmandry"
- dyn-trait-stretch (fact) L149-149: "Stretch goal: Implement experimental support for async fn in dyn Trait in nightly"
- zero-cost-axiom (constraint) L180-180: "When in doubt, zero-cost is our compass", "abstraction tax"
- generator-design-meetings (limit) L247-247: "2 meetings expected"
- rfl-arm64-flags (fact) L415-415: "arm64: -Zbranch-protection, -Zfixed-x18, -Zuse-sync-unwind"
- build-std-patching-open (open-question) L480-480: "this RFC will decide whether patching or modifying std is a supported use case"
- all-hands-funding (fact) L565-566: "Complete for event", "Rust Foundation | Complete for travel"
- vision-draft-at-all-hands (fact) L647-647: "at the Rust All Hands in May"
- vision-data-3-months (limit) L706-707: "gathering and summarizing data for the first 3 months", "In early April we will begin authoring the first draft"
- vision-maintenance-team-open (open-question) L739-739: "there might be a role for a longer-term maintenance team", "That's a topic for another day"
- goals-team-and-updates (fact) L785-786: "Create a team to run the goal program in a more sustainable way", "Publish monthly status updates"
- progress-all-hands (fact) L837-837: "9 of 28"
- progress-rfl (fact) L838-838: "11 of 26"
- guests-invited (fact) L857-857: "invited roughly 20 guests so far", "Only two of them needed funding"
- cast-hard-error-proposal (decision-status) L872-872: "make this sort of cast a hard error at least outside of an unsafe block", "future-compatibility-warning and found it was infeasible"


## s03-warehouse-scanner-spec

Matched with different kinds:
- agency-never-leads (negation) / agency-never-lead-or-admin (constraint)
- truck-no-partial-multi-carton (constraint) / truck-no-partial-multicarton (negation)
- no-signout-with-queue (negation) / no-signout-with-queue (constraint)
- reference-data-24h (constraint) / stale-reference-data-24h (limit)
- rollout-freeze (negation) / go-live-blackout (constraint)

Unmatched in A (3):
- two-person-lift-threshold (limit) L182-182: "Items over 25 kg in a single carton"
- clock-drift-limit (limit) L345-345: "must not drift more than 2 seconds from network time"
- automation-design-disagree (constraint) L716-716: "say in your output that they disagree"

Unmatched in B (36):
- not-on-store-devices (negation) L35-35: "will not be installed on store devices"
- printer-reprint-exception (negation) L39-39: "Scanbay 2 does not drive printers, with one exception", "reprint a pallet label"
- touch-target-12mm (limit) L93-93: "at least 12 mm by 12 mm"
- scan-feedback-300ms (limit) L95-95: "Every scan gets feedback within 300 ms"
- night-volume-floor-40 (limit) L95-95: "but not below 40%"
- lead-cannot-unlock-badge (negation) L112-112: "Shift leads cannot unlock a badge early"
- picklist-held-30-min (limit) L114-114: "After 30 minutes the pick list goes back to WMS"
- no-self-chosen-task (negation) L118-118: "A worker cannot pick their own task type"
- keying-pallet-labels-only (constraint) L130-130: "Keying is allowed for pallet labels only"
- mixed-pallet-60-lines (limit) L132-132: "at most 60 lines on one mixed pallet"
- over-delivery-5pct (limit) L134-134: "up to 5% over the purchase order quantity without approval"
- damage-photos-1-to-5 (limit) L138-138: "At least 1 photo and at most 5 photos"
- damaged-never-pick-location (negation) L140-140: "Damaged units are never put away to a pick location"
- reprint-max-3 (limit) L144-144: "reprint the same label at most 3 times"
- no-free-text-short-reason (negation) L190-190: "The picker cannot type a free-text reason"
- short-pick-no-stock-adjust (negation) L192-192: "Approving a short pick never adjusts stock directly"
- pickers-cannot-move-stock (negation) L204-204: "Pickers cannot move stock"
- lead-variance-2000 (limit) L218-218: "variances with a stock value of up to 2,000 euros"
- truck-missing-items-limit (limit) L232-232: "cannot leave with more than 2 missing items without the shift lead's approval"
- returns-three-centres (negation) L238-238: "Poznań and Porto do not handle returns"
- mattresses-always-grade-c (constraint) L244-244: "Mattresses and pillows that have left their sealed wrapping are always grade C"
- offline-signin-24h (negation) L307-307: "Signing in for the first time on a device", "can sign in again offline with the same badge and PIN"
- offline-no-approvals (negation) L302-308: "What does not work offline", "Every shift lead approval"
- photo-counts-10-entries (limit) L684-684: "each damage photo counts as 10 entries"
- rejected-entries-not-retried (negation) L316-316: "because the line was cancelled while the device was offline, are not retried"
- no-stock-levels-on-device (negation) L339-339: "Stock levels are not kept on the device"
- handhelds-via-gateway-only (negation) L365-365: "Handhelds never call WMS, the staff directory or the print service directly"
- no-stack-traces-in-errors (constraint) L445-445: "Error messages never show stack traces, internal host names or WMS error codes"
- battery-20pct-after-shift (limit) L515-515: "at least 20% charge left"
- no-german-at-launch (negation) L533-533: "German is not supported at launch"
- log-retention (limit) L541-541: "it is kept for 400 days", "are kept for 30 days"
- no-names-in-scan-log (constraint) L543-543: "never written to the log itself"
- scanbay-not-decide-paper (negation) L578-578: "Scanbay 2 does not decide this"
- pilot-exit-criteria (limit) L623-628: "for 2 consecutive weeks", "which in Tilburg is 0.38%", "within 5% of their Scanbay 1 rates", "Fewer than 2% of shifts"
- rollout-spacing-poznan-last (constraint) L632-632: "at least 3 weeks apart", "Poznań goes last"
- no-updates-first-2h (constraint) L680-680: "never pushed during the first 2 hours of a shift"


## s07-cert-rotation-runbook

Unmatched in A (1):
- automation-inventory-only (constraint) L75-75: "Run steps 1 to 3 only for hostnames in the inventory table"

Unmatched in B (2):
- sandbox-wildcard-out-of-scope (negation) L22-22: "partner sandbox", "out of scope here"
- internal-api-on-internal-ca (fact) L28-28: "Only internal-api stays on the internal CA"


## s08-db-failover-runbook

Matched with different kinds:
- kfail-retired (constraint) / kfail-retired (negation)
- no-detach-b-or-c (constraint) / no-detach-b-or-c (negation)

Unmatched in A (6):
- writes-back-10-min (limit) L7-7: "have writes working again within 10 minutes of the primary failing"
- lag-alert-not-failover (negation) L89-89: "On its own it is not a reason to fail over"
- saturation-no-failover (negation) L97-97: "A failover does not help here"
- keel-never-auto-c (negation) L118-118: "It never picks kdb-main-c automatically"
- c-only-if-b-down (constraint) L142-142: "Use kdb-main-c only if kdb-main-b is down"
- record-lag-for-c (constraint) L163-163: "Write down the lag Keel reported at promotion"

Unmatched in B (11):
- bot-never-suggest-delay-report (constraint) L14-14: "Never suggest promoting kdb-main-delay or kdb-main-report"
- bot-no-failover-for-lag (constraint) L16-16: "Do not suggest a failover for a replica lag alert on its own"
- bot-unknown-alert-page (constraint) L17-17: "say that you do not know and page the database on-call"
- promote-b-no-data-loss (fact) L58-58: "Promoting kdb-main-b loses no committed data"
- viewer-cannot-fence (negation) L65-65: "cannot fence, promote or switch over"
- disk-full-failover-15-min (limit) L82-82: "Fail over only if the disk cannot be grown within 15 minutes"
- saturation-no-pod-kill (constraint) L100-100: "Do not kill its pods"
- manual-lag-limit-c (limit) L142-142: "only if its lag is under 16 MB of WAL or 5 seconds"
- lease-anomaly-escalate (constraint) L181-181: "If two nodes show a lease, or none does for more than 30 seconds"
- rebuild-not-repair (constraint) L221-221: "Do not try to repair it in place"
- oncall-no-status-page (negation) L247-247: "does not post on the status page directly"


## s12-search-migration-status

Matched with different kinds:
- no-reindex-in-freeze (constraint) / no-reindex-in-freeze (negation)
- gates-green-three-days (constraint) / gates-green-three-days (limit)
- freshness-14-days-past-25 (constraint) / hold-25-until-14-green-days (limit)

Unmatched in A (2):
- damaged-index-reindex-exception (negation) L153-153: "unless the search on-call and the programme lead both agree that the live index is damaged"
- score-drop-written-exception (negation) L189-189: "unless the programme lead agrees it in writing"

Unmatched in B (17):
- no-personalised-ranking (negation) L65-65: "Personalised ranking is also out of scope for the first phase"
- corvidex-index-limits (limit) L97-97: "at most 40 million documents per index and at most 8 indexes"
- no-cost-fields-in-index (negation) L137-137: "does not hold any cost price, margin or supplier field"
- no-isbn-spell-correction (negation) L159-159: "We do not correct queries that look like an ISBN"
- never-same-bucket-both-engines (constraint) L253-253: "Never set both engines to serve the same bucket"
- red-gate-two-days-lead-decides (constraint) L276-276: "red for two days in a row, the programme lead decides whether to roll back"
- no-staging-latency-in-gates (constraint) L280-280: "nobody should quote staging latency in a gate discussion"
- no-a11y-signoff-percentage-step (negation) L289-289: "sign-off is not needed for a ramp step that only changes the percentage"
- load-test-approval-not-in-freeze (constraint) L291-291: "needs the programme lead's approval and must not run during the peak trading freeze"
- bulk-isbn-out-of-gate-report (negation) L316-316: "Bulk searches are left out of the gate report"
- indexer-priority-at-50000 (limit) L404-404: "when its queue is longer than 50,000 changes"
- freshness-breach-rollback-to-5 (constraint) L455-455: "If freshness goes past 5 minutes, the on-call rolls back to 5%"
- no-rollback-after-folio-stopped (negation) L478-478: "From this point there is no rollback to Folio"
- folio-query-logs-not-copied (constraint) L481-481: "The query logs are not copied anywhere before the wipe", "anonymised sample of 2 million queries"
- no-person-admin-key (negation) L507-507: "No person has an admin key"
- no-shopper-announcement (constraint) L619-619: "We do not tell shoppers that search is changing"
- no-direct-corvidex-contact (constraint) L621-621: "Please do not contact Corvidex directly about our account"
