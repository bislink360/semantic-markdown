L1-L6: front matter (title, summary, status=approved) — "# KEP-753: Sidecar containers", "Sidecar containers are a new type of containers that start among the Init containers, run through the lifecycle of the Pod and don’t block pod termination.", "Status: implemented." (KEP status implemented, stage stable, mapped to `approved`)
L232: :::question — "Decision on this alternative can be postponed to after alpha implementation.", interim answer "The current idea is to implement sidecars as a part of `initContainers`"
L678: :::question — "The biggest question is resources reuse for sidecar containers and other init containers", "The decision on this is not blocking the KEP though. Until it is decided, the resources of a sidecar container are not reused"
L999: :::warning — "**Note**, downgrade requires node drain. So we will not support scenarios when Pod already running on the node will need to be handled by the restarted kubelet" (called out, no stated harm)
L1250: {agent=skip} — "## Implementation History"
L1352: :::decision{status=rejected} — "### Alternative 1. Sidecar containers as a separate collection", "This alternative was rejected for the following reasons"
L1370: :::decision{status=rejected} — "### Alternative 2. DependOn semantic between containers", "The alternative was rejected for the following reasons"
L1380: :::decision{status=rejected} — "### Alternative 3. Phases", "This alternative was rejected because it was hard to impossible to fit all containers"
L1391: :::decision{status=rejected} — "### Alternative 4. TerminatePod on container completion", "This idea was rejected"
L1406: :::decision{status=rejected} — "### Alternative 5. Injection of sidecar containers thru the "external" object", "However this alternative was rejected as the change introduced is beyond the scope of the sidecar KEP"
L1453: :::decision{status=superseded} — "### Proposal (2019)", "Create a way to define containers as sidecars, this will be an additional field to the `container.lifecycle` spec: `Type`", appendix status "Status: implementable", replaced per "This design replaces the `lifecycle.type: Sidecar` field of the 2019 version of this KEP" (L220)
