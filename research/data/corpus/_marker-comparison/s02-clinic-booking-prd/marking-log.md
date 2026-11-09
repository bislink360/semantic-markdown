# Marking log: s02-clinic-booking-prd (marker ai-marker-2)

Line numbers refer to doc.smd. One line per mark, with the md words that justify it.

L3: front matter title — "Pawpoint appointment booking: product requirements" (the md's # title line, removed from the body)
L4: front matter summary — "This document describes online appointment booking in the Pawpoint app, so pet owners can book, move and cancel visits at any Pawpoint clinic without calling the front desk."
L5: front matter status=review — "Status: in review." (in review maps to review)

L14: {agent=skip} — "Background"
L83: :::danger — "**Important:** Two confirmed appointments for the same vet must never overlap … caused two operations to be cancelled on the day"
L107: :::decision{status=superseded} — "We chose a deposit because … / D3: This replaces the deposit described under Payments and deposits, which was agreed in September"
L121: :::warning — "**Warning:** Reminder messages must not include the reason for the visit or any medical detail about the pet"
L169: :::api{method=GET path="/v1/clinics/{clinicId}/slots"} — "`GET /v1/clinics/{clinicId}/slots` Query parameters: … Rate limit: 30 searches per minute"
L179: :::api{method=POST path="/v1/holds"} — "`POST /v1/holds` Body: `clinicId`, `slotId`, `petId`. Returns a hold"
L187: :::api{method=POST path="/v1/appointments"} — "`POST /v1/appointments` … Returns `201` with the appointment, or `410` if the hold has expired"
L205: :::api{method=PATCH path="/v1/appointments/{id}"} — "`PATCH /v1/appointments/{id}` with a new `slotId` moves an appointment (paragraph split at the sentence boundary, no words changed)"
L208: :::api{method=DELETE path="/v1/appointments/{id}"} — "`DELETE /v1/appointments/{id}` cancels it. Both return the fee"
L304: :::risk{impact=high likelihood=medium} — "Risk: clinics do not keep vet availability in Rota up to date … Impact high, likelihood medium"
L308: :::risk{impact=high likelihood=low} — "Risk: owners book consultations for problems that need an urgent visit … Impact high, likelihood low"
L312: :::risk{impact=low likelihood=medium} — "Risk: SMS costs grow faster than planned. Impact low, likelihood medium"
L320: :::decision{status=accepted date=2026-07-30} — "D1. Real-time booking against Rota. Accepted 2026-07-30"
L324: :::decision{status=rejected date=2026-08-12} — "D2. Buy a third-party booking widget. Rejected 2026-08-12"
L328: :::decision{status=accepted date=2026-10-14} — "D3. Late-cancellation fee instead of a deposit. Accepted 2026-10-14"
L332: :::decision{status=proposed date=2026-10-20} — "D4. Show consultation prices in the app. Proposed 2026-10-20 … Product has not agreed to this yet"
L336: :::decision{status=accepted date=2026-09-03} — "D5. Owners choose a named vet or "first available". Accepted 2026-09-03"
L342: :::question — "Multi-pet appointments … Undecided. Until then, each pet needs its own appointment"
L346: :::question — "Do nurse checks count toward the 3-appointment limit? … Not decided yet. Until we decide"
L350: :::question — "Second language … This is open, with no date for a decision"
L358: {agent=skip} — "Appendix: meeting notes … These notes are kept for the people who were there and for context. They are not requirements."
