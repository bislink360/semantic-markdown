Source: adapted from "ADR002: Default Software Catalog File Format", https://github.com/backstage/backstage/blob/master/docs/architecture-decisions/adr002-default-catalog-file-format.md, Apache-2.0 (licence evidence: https://github.com/backstage/backstage/blob/master/LICENSE), retrieved 2026-11-06 at commit b5545900a4d32a641f644c5b483cd5b00b0b61a0 (latest commit touching the file, 2025-05-09).
Size: S, kind: ADR/RFC, include: no
Marker: ai-marker-f (second marker, AI agent)

Changes:
- Removed: the Docusaurus front matter (id, title, description); the `description` subsection under Metadata; the repeated key restrictions and the repeated "`backstage.io/` prefix is reserved" sentence in the `annotations` subsection (replaced by one added sentence, see below).
- Added: the sentence introducing the diagram and the Mermaid flowchart (lines 33–40 of doc.md).
- Added: the superseded early-draft rule of one entity per file (lines 47–51) and the sentence that replaces it under Format, "This replaces the one-entity-per-file rule of the early draft, which is superseded." (lines 60–61).
- Added: the called-out warning about renaming an entity that others reference (lines 154–157).
- Added: the open question on namespaces with its interim fallback (lines 166–169).
- Added: "Keys follow the same rules as label keys." in the `annotations` subsection (line 206), in place of the removed repeated restrictions.
- Changed: the `# ADR002: …` title line comes from the source's front matter title. "Core Concepts" was a level-3 heading under Background and is now a level-2 heading, so that the Background section holds only the background and its Inspiration subsection.
