# Marking log: p06-free-threading-pep

Marker: ai-marker-1. Status mapping: md line 3 "Status: Final, accepted on 24-Oct-2023." mapped to `approved`.

L10: `:::decision{status=accepted}` — "**Note:** The Steering Council accepts PEP 703, but with clear proviso"
L797: `:::decision{status=superseded}` — "The problematic borrowed reference APIs are supplemented with functions … `PyList_FetchItem` … `PyDict_FetchItem` … `PyWeakref_FetchObject` (line 1582: "were not added. They are replaced by `PyList_GetItemRef`, `PyDict_GetItemRef` and `PyWeakref_GetRef`")"
L1127: `:::danger` — "**Warning:** Do not declare in the `Py_mod_gil` slot that an extension does not use the GIL if it keeps global state … concurrent calls from several threads can corrupt that state and crash the process."
L1137: `:::decision{status=superseded}` — "the user can also override the behavior at runtime by setting the `PYTHONGIL` environment variable (line 1574: "The `PYTHONGIL` environment variable is superseded by `PYTHON_GIL`")"
L1403: `{agent=skip}` — "This section is history for interested readers. Nothing in it is needed to build or use CPython without the GIL."
L1476: `:::decision{status=rejected} Why Not Use a Concurrent Garbage Collector?` — "## Rejected Ideas / ### Why Not Use a Concurrent Garbage Collector?"
L1489: `:::decision{status=rejected} Why Not Deprecate `PyDict_GetItem` in Favor of `PyDict_FetchItem`?` — "## Rejected Ideas … This PEP does *not* propose deprecating `PyDict_GetItem`"
L1515: `:::decision{status=rejected} Why Not Use PEP 683 Immortalization?` — "## Rejected Ideas / ### Why Not Use PEP 683 Immortalization?"
L1527: `:::question Improved Specialization` — "## Open Issues / ### Improved Specialization … It is possible to support specializing multiple times, but that requires more investigation and is not part of this PEP."
L1540: `:::question Python Build Modes` — "The path to this goal remains an open issue … Whether and when the GIL is disabled by default is undecided. Until then, the default build keeps the GIL"
L1572: `:::question Integration` — "## Open Issues / ### Integration (listed by the source under Open Issues)"
L1584: `:::question Mitigations for Single-Threaded Performance` — "the choice of optimizations and their trade-offs remain an open issue."
