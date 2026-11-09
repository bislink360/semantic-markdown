Source: adapted from "PEP 263 – Defining Python Source Code Encodings", https://github.com/python/peps/blob/main/peps/pep-0263.rst (rendered at https://peps.python.org/pep-0263/), public domain (licence evidence: the PEP's own Copyright section, "This document has been placed in the public domain.", https://raw.githubusercontent.com/python/peps/main/peps/pep-0263.rst), retrieved 2026-11-06 at commit b990d0599141b030e68d1a1bb91aac9981d1fd56.
Size: S, kind: spec or PRD, include: no
Marker: ai-marker-e (second marker, AI agent)

Changes:
- Removed: the e-mail addresses of the authors; the empty Post-History header field.
- Added: the summary table of which encoding the parser uses, with its lead-in sentence (lines 55–63 of doc.md).
- Added: the note for automated tools and agents (line 143 of doc.md).
- Added: the Mermaid flowchart of the five tokenizer/compiler steps (lines 163–169 of doc.md).
- Added: the paragraph saying PEP 3120 replaced the ASCII default for Python 3.0, which makes the ASCII default on line 21 a superseded decision (line 195 of doc.md). PEP 3120 and the UTF-8 default are real.
- Added: the "Open Issues" section with the undecided UTF-16 question and its interim rule (lines 197–199 of doc.md).
- Changed: converted from reStructuredText to Markdown (literal blocks to fenced code blocks, footnote references to plain [1] and [2], the reference targets to a list). The PEP header became a prose status line (line 3). The paragraph about the UTF-8 BOM plus a magic comment became a "> **Warning:**" blockquote (line 53), with its words unchanged, so that one constraint is called out.
