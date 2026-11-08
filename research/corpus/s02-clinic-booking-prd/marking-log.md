L1-6: front matter title, summary, status — "# Pawpoint appointment booking: product requirements", "This document describes online appointment booking in the Pawpoint app, so pet owners can book, move and cancel visits at any Pawpoint clinic without calling the front desk.", "Status: in review." (status mapped to `review`: "in review")
L14: {agent=skip} — "## Background"
L83: :::danger — "**Important:** Two confirmed appointments for the same vet must never overlap" … "caused two operations to be cancelled on the day"
L107: :::decision{status=superseded} — "This replaces the deposit described under Payments and deposits, which was agreed in September." (D3)
L121: :::warning — "**Warning:** Reminder messages must not include the reason for the visit"
L169: :::api{method=GET path="/v1/clinics/{clinicId}/slots"} — "`GET /v1/clinics/{clinicId}/slots`" with its query parameters and responses
L179: :::api{method=POST path="/v1/holds"} — "`POST /v1/holds`" with its body and responses
L187: :::api{method=POST path="/v1/appointments"} — "`POST /v1/appointments`" with its body and responses
L299: :::risk{impact=high likelihood=medium} — "Risk: clinics do not keep vet availability in Rota up to date" … "Impact high, likelihood medium."
L303: :::risk{impact=high likelihood=low} — "Risk: owners book consultations for problems that need an urgent visit" … "Impact high, likelihood low."
L307: :::risk{impact=low likelihood=medium} — "Risk: SMS costs grow faster than planned. Impact low, likelihood medium."
L315: :::decision{status=accepted date=2026-07-30} — "**D1. Real-time booking against Rota.** Accepted 2026-07-30"
L319: :::decision{status=rejected date=2026-08-12} — "**D2. Buy a third-party booking widget.** Rejected 2026-08-12."
L323: :::decision{status=accepted date=2026-10-14} — "**D3. Late-cancellation fee instead of a deposit.** Accepted 2026-10-14"
L327: :::decision{status=proposed date=2026-10-20} — "**D4. Show consultation prices in the app.** Proposed 2026-10-20"
L331: :::decision{status=accepted date=2026-09-03} — "**D5. Owners choose a named vet or \"first available\".** Accepted 2026-09-03."
L337: :::question — "**Multi-pet appointments.**" … "Undecided. Until then, each pet needs its own appointment"
L341: :::question — "**Do nurse checks count toward the 3-appointment limit?**" … "Not decided yet. Until we decide, nurse checks count toward the limit"
L345: :::question — "**Second language.**" … "This is open, with no date for a decision, and the booking screens are English only in 7.4."
L353: {agent=skip} — "## Appendix: meeting notes" … "These notes are kept for the people who were there and for context. They are not requirements."
