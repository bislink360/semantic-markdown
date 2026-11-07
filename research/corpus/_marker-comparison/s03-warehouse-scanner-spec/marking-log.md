# Marking log: s03-warehouse-scanner-spec (marker ai-marker-2)

Line numbers refer to doc.smd. One line per mark, with the md words that justify it.

L3: front matter title — "Scanbay 2: handheld scanner app requirements" (the md's # title line, removed from the body)
L4: front matter summary — "This document sets out the requirements for Scanbay 2, the app that warehouse staff at Oakbay Home use on handheld barcode scanners to receive, store, pick, count and load stock."
L5: front matter status=approved — "Status: approved for build." (approved for build maps to approved)

L18: {agent=skip} — "Background and history … This section is for readers who were not around for Scanbay 1. Nothing in it is a requirement."
L189: :::danger — "**Warning:** Scanbay 2 must never let a single worker confirm … The flag is there because of back injuries … will lead to enforcement action"
L319: :::decision{status=superseded date=2025-09-15} — "Decision (2025-09-15, architecture review): the offline queue on a device holds at most 200 scans / later: This replaces the limit of 200 scans set in September 2025"
L358: :::decision{status=superseded date=2025-11-20} — "Decision (2025-11-20, architecture review): Scanbay 2 is built as a progressive web app / later: This replaces the November 2025 decision to build it as a progressive web app"
L390: :::api{method=GET path="/v1/picklists/next"} — "`GET /v1/picklists/next` Returns the next pick list … Responses: `200` …"
L414: :::api{method=POST path="/v1/picklists/{pickListId}/lines/{lineId}/confirm"} — "`POST /v1/picklists/{pickListId}/lines/{lineId}/confirm` Confirms that a line was picked"
L438: :::api{method=POST path="/v1/picklists/{pickListId}/lines/{lineId}/short"} — "`POST /v1/picklists/{pickListId}/lines/{lineId}/short` Reports a short pick"
L448: :::api{method=POST path="/v1/picklists/{pickListId}/drop"} — "`POST /v1/picklists/{pickListId}/drop` Closes the pick list at the drop location"
L589: :::danger — "**Important:** Never lower a SEV1 below SEV2 … past incidents have run for hours with nobody senior watching"
L697: :::decision{status=accepted date=2026-03-18} — "Native Android app: Decision (accepted 2026-03-18, architecture review)"
L707: :::decision{status=accepted date=2026-05-06} — "Offline queue size: Decision (accepted 2026-05-06, product and operations)"
L715: :::decision{status=rejected date=2026-02-11} — "Voice picking: Decision (rejected 2026-02-11, operations)"
L721: :::decision{status=accepted date=2026-06-24} — "Keying quantities: Decision (accepted 2026-06-24, product)"
L729: :::question — "Undecided: whether Scanbay 2 supports the Bluetooth ring scanners at launch … Until then"
L735: :::question — "Open question: whether the pick screen shows a product photo for each line … Until this is settled"
L741: :::risk{impact=high likelihood=medium} — "Risk: the WMS team cannot deliver the timestamp ordering … Impact high, likelihood medium"
L745: :::risk{impact=medium likelihood=medium} — "Risk: the H7 firmware update … Impact medium, likelihood medium"
L749: :::risk{impact=medium likelihood=low} — "Risk: works councils in Lyon or Tilburg object … Impact medium, likelihood low"
L755: :::agent — "Notes for automated coding assistants: This document is also read by the coding assistants and code generation tools … follow these rules"
L777: {agent=skip} — "Appendix A: notes from the design review on 2026-06-24 (for the team)"
L802: {agent=skip} — "Appendix B: notes from floor visits (for the team) … They are notes, not requirements."
L816: {agent=skip} — "Document history"
