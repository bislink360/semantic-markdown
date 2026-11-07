# Marking log: p03-sidecar-containers-kep

Marker: ai-marker-1. Status mapping: md line 3 "Status: implemented. Stage: stable." mapped to `approved` (the KEP is accepted and shipped).

L240: `:::question` — "*Alternative* is to introduce a new collection `infrastructureContainers` … Decision on this alternative can be postponed to after alpha implementation."
L314: `:::risk{likelihood=low} Scenario 1. User decides to use sidecars as a way to run regular containers` — "### Risks and Mitigations … This can be seen as an abuse of the concept, and may lead to issues … this use of sidecar containers will unlikely lead to "unexpected" behavior"
L343: `:::risk{likelihood=low} Scenario 1.a` — "webhooks will likely inject sidecar containers to be first, so the risk is minimal here as well."
L367: `:::risk{impact=low} Scenario 3. Long initialization tasks running in-parallel` — "This pattern may lead to race conditions and be error prone. … There is not much risk, however, even if the user abuses this pattern"
L412: `:::risk{likelihood=low} Scenario 7. Risk of porting existing sidecars to the new mechanism naively` — "There is risk associated with people moving sidecars as implemented today to use the new pattern. … this is not likely the problem."
L686: `:::question` — "The biggest question is resources reuse for sidecar containers and other init containers … The decision on this is not blocking the KEP though. Until it is decided, the resources of a sidecar container are not reused"
L723: `:::decision{status=accepted}` — "However, we decided on an alternative that doesn't require additional fields or hooks"
L1009: `:::warning` — "**Note**, downgrade requires node drain. So we will not support scenarios when Pod already running on the node will need to be handled by the restarted kubelet"
L1260: `{agent=skip}` — "## Implementation History"
L1362: `:::decision{status=rejected} Alternative 1. Sidecar containers as a separate collection` — "This alternative was rejected for the following reasons"
L1380: `:::decision{status=rejected} Alternative 2. DependOn semantic between containers` — "The alternative was rejected for the following reasons"
L1390: `:::decision{status=rejected} Alternative 3. Phases` — "This alternative was rejected because it was hard to impossible to fit all containers and scenarios into predefined buckets"
L1401: `:::decision{status=rejected} Alternative 4. TerminatePod on container completion` — "This idea was rejected"
L1416: `:::decision{status=rejected} Alternative 5. Injection of sidecar containers thru the "external" object` — "However this alternative was rejected as the change introduced is beyond the scope of the sidecar KEP"
L1463: `:::decision{status=superseded} Proposal (2019)` — "This design replaces the `lifecycle.type: Sidecar` field of the 2019 version of this KEP, kept below in "Appendix: the 2019 sidecar KEP". (line 215)"
