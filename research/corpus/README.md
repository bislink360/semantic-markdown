# Study 1 corpus

This folder is the evaluation corpus for Study 1. It is draft 0.2 and it is not frozen.

The corpus has 24 documents, balanced as the study protocol asks: 8 per size (about 2k, 8k and 20k tokens), 6 per kind (spec or PRD, ADR or RFC, runbook, status report or plan) and 12 per source. Six documents use `:::include`.

- Folders starting with `s` were written for the study. They are synthetic, they describe fictional companies and systems, and they were drafted with AI assistance.
- Folders starting with `p` are adapted from permissively licensed public documents (Python PEPs, Kubernetes enhancement proposals and documentation, a Backstage ADR, Rust project goals). Each `source.md` names the source, its licence, the commit and every change. `_licenses/` holds the licence notices.

Each document folder holds `doc.md` (plain Markdown), `doc.smd` (the same text with Semantic Markdown markup), `marking-log.md` (one line per mark and the words that justify it), `source.md`, `annotations.json` (the resolved items) and `tasks.json`.

## Who did what

Every role in `research/annotation-guide.smd` 0.2 was drafted by a separate AI agent that saw only what the guide allows for its role, as the guide's section "Roles drafted by AI agents" describes. The `annotator` and `author` fields name the role.

| Role | Documents |
|-|-|
| Marker (author's half) | `s` documents |
| Second marker | `p` documents |
| Annotator | all 24, never the document's marker |
| Second annotator | the seeded quarter in `corpus.json` |
| Adjudicator | the documents with two annotations |
| Task writer | all 24, never the document's marker or annotator |

People verify every mark, item and task before the corpus is frozen. Until the freeze record in `corpus.json` says so, nothing in this folder is study data.

Folders whose names start with `_` are not documents and the harness skips them.

- `_shared/` holds files that documents pull in with `:::include`. `incident-severity.smd` is included by s03 and s09, `data-retention.smd` by s06 and s11, and `kubeadm-certificate-renewal.smd` by p08 and p09. The retention text is Querent's policy, so s11 presents Querent as Stridewell's survey vendor. In each `doc.md` the included text is written out at the same place.
- `_agreement/` holds the pre-resolution annotations, the confirmed pairs and the agreement report for the second-annotator quarter.
- `_marker-comparison/` holds the independent re-marking of eight documents and the comparison report.
- `_licenses/` holds the licence notices of the adapted documents.

Front matter `status` is mapped from each document's own status line to a value Semantic Markdown accepts, and the marking log says how.
