# Marking log: s09-payments-oncall-runbook (marker ai-marker-2)

Line numbers refer to doc.smd. One line per mark, with the md words that justify it.

L3: front matter title — "Paywise Rail on-call runbook" (the md's # title line, removed from the body)
L4: front matter summary — "This runbook is what the Paywise Rail on-call engineer uses to keep card and bank payments flowing: how to read a page, which levers are safe to pull, and when to wake someone else up."
L5: front matter status=approved — "Status: approved for use on call." (approved for use on call maps to approved)

L24: :::agent — "Notes for automated assistants: The on-call chat assistant and the alert triage bot both read this runbook … If you are one of those tools, follow these rules."
L176: :::danger — "**Important:** Never lower a SEV1 below SEV2 … past incidents have run for hours with nobody senior watching"
L188: :::danger — "**Warning:** Never replay, retry or re-send a capture, refund or payout by hand … A capture sent twice charges the cardholder twice"
L196: :::danger — "**Important:** Do not touch the token vault … any change outside the vault team's process puts our card data compliance at risk"
L410: :::warning — "**Important:** Evacuation needs the engineering manager on call to agree … Nobody else runs it at the same time"
L556: :::decision{status=accepted date=2026-04-14} — "Manual acquirer failover (accepted 2026-04-14)"
L562: :::decision{status=accepted date=2025-11-03} — "Fraud fail-open outside business hours (accepted 2025-11-03)"
L568: :::decision{status=rejected date=2026-02-09} — "Second region for the token vault (rejected 2026-02-09)"
L574: :::decision{status=accepted date=2024-09-16} — "Webhook retry schedule (accepted 2024-09-16)"
L582: :::question — "Should on-call be allowed to issue bulk refunds? Undecided. … Until then, on-call never issues refunds"
L588: :::question — "Should Risk Engineering have an out-of-hours rota? Undecided as well. … Until then"
L598: task :priority — "- [x] … — @tomas-veidt, P1, 2026-06-30"
L599: task :priority — "- [ ] … — @amara-quist, P2, 2026-11-15"
L600: task :priority — "- [ ] … — @lena-marsh, P2, 2026-11-20"
L601: task :priority — "- [ ] … — @kofi-annerud, P3, 2026-11-10"
L602: task :priority — "- [ ] … — @priya-nandakumar, P3, 2026-12-15"
L697: {agent=skip} — "Notes for new on-call engineers … These notes are for people joining the rota, not for the on-call tools."
L713: {agent=skip} — "Background … It is for people who are new to the team or who want the history behind a rule. Nothing in it is needed to handle a page."
L731: {agent=skip} — "Notable incidents … They are kept for context and for training … do not follow them."
L765: {agent=skip} — "Review meeting notes (2026-10-08) … Notes from the quarterly runbook review, for the people on the rota who could not attend."
L777: {agent=skip} — "Runbook changes … A record of changes to this runbook, newest first. It is kept for reviewers and auditors."
