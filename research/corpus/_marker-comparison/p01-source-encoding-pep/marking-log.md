# Marking log: p01-source-encoding-pep

Marker: ai-marker-1. Status mapping: md line 3 "Status: Final." mapped to `approved` (a Final PEP is accepted and in force).

L26: `:::decision{status=superseded}` — "Python will default to ASCII as standard encoding if no other encoding hints are given. … PEP 3120, accepted for Python 3.0, replaced the ASCII default described under "Defining the Encoding""
L60: `:::danger` — "**Warning:** … the only allowed encoding for the comment is 'utf-8'. Any other encoding will cause an error."
L152: `:::agent` — "Note for automated tools and agents that create or rewrite Python source files: keep an existing encoding declaration on line 1 or 2"
L210: `:::question` — "Whether a later version should accept source files in encodings that use two or more bytes for all characters, such as UTF-16, is undecided. Until then, …"
L223: `{agent=skip}` — "## History"
