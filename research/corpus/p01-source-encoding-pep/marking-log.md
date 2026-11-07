L1-L6: front matter (title, summary, status=approved) — "# PEP 263: Defining Python Source Code Encodings", "This PEP proposes to introduce a syntax to declare the encoding of a Python source file.", "Status: Final." (PEP status Final mapped to `approved`)
L26: :::decision{status=superseded} — "Python will default to ASCII as standard encoding if no other encoding hints are given.", replaced later by "PEP 3120, accepted for Python 3.0, replaced the ASCII default described under "Defining the Encoding"" (L207)
L60: :::danger — "> **Warning:** If a source file uses both the UTF-8 BOM mark signature and a magic encoding comment, the only allowed encoding for the comment is 'utf-8'." with stated harm "Any other encoding will cause an error."
L152: :::agent — "Note for automated tools and agents that create or rewrite Python source files: keep an existing encoding declaration on line 1 or 2"
L206: :::decision{status=accepted} — "PEP 3120, accepted for Python 3.0, replaced the ASCII default"
L212: :::question — "## Open Issues", "is undecided. Until then, such files must be converted to an ASCII compatible encoding"
L225: {agent=skip} — "## History" (revision history of the PEP)
