# Study 1 corpus

This folder is the evaluation corpus for Study 1. It is draft 0.1 and it is not frozen.

The documents whose folder names start with `s` were written for the study. They are synthetic, they describe fictional companies and systems, and they were drafted with AI assistance. The author reviews each one before the corpus is frozen.

The 12 documents adapted from permissively licensed public sources are not added yet.

Each document folder holds `doc.md` (plain Markdown), `doc.smd` (the same text with Semantic Markdown markup), `marking-log.md` (one line per mark and the words that justify it) and `source.md`. The files `annotations.json` and `tasks.json` are empty on purpose. Independent annotators fill them later, following `research/annotation-guide.smd`.

Folders whose names start with `_` hold shared files that documents pull in with `:::include`. The harness does not treat them as documents. `_shared/incident-severity.smd` is included by s03 and s09, and `_shared/data-retention.smd` by s06 and s11. The retention text is Querent's policy, so s11 presents Querent as Stridewell's survey vendor. In each `doc.md` the included text is written out at the same place.

Front matter `status` is mapped from each document's own status line to a value Semantic Markdown accepts, and the marking log says how.

Nothing in this folder is study data until the freeze record in `corpus.json` says so.
