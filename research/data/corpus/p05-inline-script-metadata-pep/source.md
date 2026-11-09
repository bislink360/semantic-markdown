Source: adapted from "PEP 723 – Inline script metadata", https://github.com/python/peps/blob/main/peps/pep-0723.rst (published at https://peps.python.org/pep-0723/), public domain or CC0-1.0 (licence evidence: the PEP's own Copyright section, "This document is placed in the public domain or under the CC0-1.0-Universal license, whichever is more permissive.", https://github.com/python/peps/blob/main/peps/pep-0723.rst#copyright), retrieved 2026-11-06 at commit 8e4f0b0d3734cd447c9c347bae2a21d886813ad0 (latest commit touching the file, 2025-08-08). The superseded "pyproject type" text comes from the same file in its Provisional revision, commit e36a5a65c44f61303a7be57df17443e0cb5328bd (2023-11-07), https://github.com/python/peps/blob/e36a5a65c44f61303a7be57df17443e0cb5328bd/peps/pep-0723.rst. History dates come from the PEP header and the file's commit history.
Size: M, kind: ADR/RFC, include: no
Marker: ai-marker-f (second marker, AI agent)

Changes:
- Removed: the rST header fields as a block (kept as one status line, without e-mail addresses and without Post-History); the canonical-spec directive; the Rejected Ideas subsection "Why not use a requirements file for dependencies?"; the empty References heading; "None at this point." under Open Issues (replaced, see below). In the copied provisional text: the footnote marker [3], the PEP 508 and version specifier "MUST be valid" clauses, the tool table sentence and the two "Script runners MUST/SHOULD error" sentences, all of which repeat the current Specification.
- Added: the section "Provisional specification" with its lead-in (lines 63–67 of doc.md), followed by the "pyproject type" text and example copied from the Provisional revision of the PEP (lines 69–99).
- Added: "The `script` type replaces the `pyproject` type of the provisional specification and its `[run]` table, which are superseded." (lines 173–176).
- Added: the sentence introducing the diagram and the Mermaid flowchart (lines 156–166).
- Added: the called-out warning in Security Implications (lines 318–321).
- Added: the section "Notes for automated tools" with its note to automated tools and agents (lines 365–374).
- Added: the open issue on package indexes with its interim fallback (lines 708–713), replacing "None at this point.".
- Added: the "History" section (lines 715–729), built from the PEP header dates and the file's commit history.
- Changed: reStructuredText converted to Markdown (headings, inline literals, links, code directives to fenced blocks, literal blocks to plain fences, footnotes to Markdown footnotes, the list-table in "How to Teach This" to a Markdown table). Two internal rST references were turned into anchor links. The `# PEP 723: …` title line and the status line come from the PEP header.
