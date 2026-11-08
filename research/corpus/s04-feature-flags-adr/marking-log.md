L1-L6: front matter title, summary, status — "# ADR-022: Feature flags for the Linguaroo apps", "Linguaroo will run feature flags on Pennant, an open-source flag server that we host ourselves, with flags evaluated on the device by the Pennant SDK in the iOS and Android apps.", "Status: accepted on 2026-04-22" (status mapped to `approved`: "accepted")
L12: {agent=skip} — "## Background (for people new to the team)"
L34: :::decision{status=rejected date=2026-03-18} — "Decision (rejected 2026-03-18): Option B, the hosted Flagstaff service."
L42: :::decision{status=accepted date=2026-04-22} — "Decision (accepted 2026-04-22): we adopt Option C."
L50: :::decision{status=superseded date=2026-02-10} — "Decision (accepted 2026-02-10): flag evaluation happens on the server only.", and at L43 "This replaces the server-side evaluation decision of 2026-02-10 in \"How flags are evaluated\""
L87: :::danger — "**Important:** Never use a flag to change what a learner pays or to gate a paid feature." with stated harm "breaks store rules and, as the streak freeze incident showed, ends in refunds"
L99: :::question — "Undecided: whether the web app should evaluate flags locally like the mobile apps.", "Until then, the web app keeps calling the Pennant server's evaluate endpoint"
