L1-6: front matter title, summary, status — "# RFC-0042: Tenant data isolation for Querent", "This RFC sets out how Querent keeps each customer's data separate from every other customer's data, in the database, the search cluster, object storage, caches, background jobs and exports.", "Status: accepted on 2026-09-22" (status mapped to `approved`: "accepted")
L16: {agent=skip} — "## Background and history"
L84: :::decision{status=superseded} — "The rules that service code follows today come from ADR-0007. Its decision text reads:" and, in Decision, "This RFC supersedes ADR-0007."
L120: :::danger — "**Warning:** Do not grant any runtime role the right to set `app.tenant_id`" … "A role that can set it freely can read every tenant's data"
L157: :::decision{status=rejected date=2026-07-14} — "Outcome: rejected at the 2026-07-14 review." (Option A)
L167: :::decision{status=accepted} — "Outcome: accepted, with per-tenant encryption keys for response data" (Option B)
L179: :::decision{status=rejected date=2026-07-14} — "Outcome: rejected at the 2026-07-14 review, for both the all-tenants and the Enterprise-only variants." (Option C)
L191: :::decision{status=rejected} — "Outcome: rejected as the general model. Kept for the Dedicated plan only" (Option D)
L201: :::decision{status=rejected} — "Outcome: rejected as an isolation option." (Option E)
L221: :::decision{status=accepted date=2026-09-22} — "Option B is accepted, as decided at the architecture review on 2026-09-22."
L295: :::danger — "**Important:** Never copy response data out of a break-glass session" … "had to be removed from three systems and reported to the customer as a data handling incident"
L373: :::include{file=../_shared/data-retention.smd} — "The retention periods are the company-wide ones" (the passage under "### Retention periods", doc.md L350-365, is the body of the shared file)
L575: :::risk{impact=medium likelihood=medium} — "Risk: a code path that does not use `db.InTenant` is missed" … "Impact medium, likelihood medium."
L579: :::risk{impact=high likelihood=low} — "Risk: query plans on `answers` change after forcing" … "Impact high, likelihood low."
L583: :::risk{impact=medium likelihood=high} — "Risk: the 140 places with a silenced linter comment" … "Impact medium, likelihood high."
L587: :::risk{impact=high likelihood=low} — "Risk: per-tenant keys add a dependency on the key management service" … "Impact high, likelihood low."
L628: :priority[P1] :due[2026-11-16] — "P1, @dana, due 2026-11-16"
L629: :priority[P2] :due[2026-12-15] — "P2, @kofi, due 2026-12-15"
L630: :priority[P1] :due[2026-11-27] — "P1, @rafael, due 2026-11-27"
L674: :::question — "**Row-level security in the warehouse.**" … "Undecided. Until then, Enterprise reporting in the warehouse stays on per-tenant views"
L678: :::question — "The open question is whether an unsubscribe from one tenant's emails should affect the others." … "Until it does, unsubscribes apply to one tenant only"
L682: :::question — "This has not been decided, and for now break-glass for those plans follows the terms of service"
L688: :::agent — "This section is written for automated code review tools and coding agents that work in the Querent repositories"
L701: {agent=skip} — "## Appendix A: review meeting notes" … "kept for people who want to know how the design got here. They are not part of the specification."
L743: {agent=skip} — "## Appendix B: revision history"
L751: {agent=skip} — "## Appendix C: INC-311 in brief" … "a short account of the incident for readers who were not here at the time"
