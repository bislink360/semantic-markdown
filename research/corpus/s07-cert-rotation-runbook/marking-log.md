L1-6: front matter title, summary, status — "# Runbook: rotating TLS certificates on the Cargomint API gateway", "This runbook covers replacing the server certificates on the internal API gateway that sits in front of the shipment, tracking and billing services.", "Status: approved." (status mapped to `approved`)
L31: :::decision{status=superseded date=2024-02-20} — "Decision (2024-02-20)" … "This replaces the yearly rotation agreed in February 2024."
L35: :::decision{status=accepted date=2025-06-02} — "Decision (accepted 2025-06-02)"
L66: :::danger — "**Warning:** Do not delete or disable the previous certificate version" … "leaves the hostname with no valid certificate until a new one is issued"
L86: :::agent — "The rotation bot and any automated assistant that runs this runbook must follow these rules."
L92: :::question — "Undecided: whether the mutual TLS client certificates" … "Until then, partner client certificates are rotated by the carrier integrations team"
L96: {agent=skip} — "## Background"
