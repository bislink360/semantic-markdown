# PEP 602 – Annual Release Cycle for Python

| Field | Value |
|-|-|
| PEP | 602 |
| Author | Łukasz Langa |
| PEP-Delegate | Brett Cannon |
| Status | Active |
| Type | Process |
| Created | 04-Jun-2019 |
| Python-Version | 3.9 |
| Post-History | 09-Oct-2023 |

## Abstract

This document describes a change in the release calendar for Python starting with Python 3.9. This change accelerates the release cadence such that feature versions are released predictably every twelve months, in October every year.

## Implementation

### Seventeen months to develop a feature version

This PEP proposes that Python 3.X.0 will be developed for around 17 months:

- The first *five months* overlap with Python 3.(X-1).0's beta and release candidate stages and are thus unversioned.
- The next *seven months* are spent on versioned alpha releases where both new features are incrementally added and bug fixes are included.
- The following *three months* are spent on four versioned beta releases where **no new features** can be added but bug fixes are still included.
- The final *two months* are spent on two release candidates (or more, if necessary) and conclude with the release of the final release of Python 3.X.0.

### 1½ year of full support, 3½ more years of security fixes

After the release of Python 3.X.0, the 3.X series is maintained for five years:

- During the *first eighteen months* (1½ year) it receives bugfix updates and full releases (sources and installers for Windows and macOS) are made approximately every other month.
- For the next *forty two months* (3½ years) it receives security updates and source-only releases are made on an as-needed basis (no fixed cadence).
- The final source-only release is made *five years* after 3.X.0.

### Annual release cadence

Feature development of Python 3.(X+1).0 starts as soon as Python 3.X.0 Beta 1 is released. This creates a twelve-month delta between Python feature versions.

## Example

| Milestone | Date |
|-|-|
| 3.9 development begins | Tuesday, 2019-06-04 |
| 3.9.0 alpha 1 | Monday, 2019-10-14 |
| 3.9.0 alpha 2 | Monday, 2019-11-18 |
| 3.9.0 alpha 3 | Monday, 2019-12-16 |
| 3.9.0 alpha 4 | Monday, 2020-01-13 |
| 3.9.0 alpha 5 | Monday, 2020-02-17 |
| 3.9.0 alpha 6 | Monday, 2020-03-16 |
| 3.9.0 alpha 7 | Monday, 2020-04-13 |
| 3.9.0 beta 1 (No new features beyond this point.) | Monday, 2020-05-18 |
| 3.9.0 beta 2 | Monday, 2020-06-08 |
| 3.9.0 beta 3 | Monday, 2020-06-29 |
| 3.9.0 beta 4 | Monday, 2020-07-20 |
| 3.9.0 candidate 1 | Monday, 2020-08-10 |
| 3.9.0 candidate 2 | Monday, 2020-09-14 |
| 3.9.0 final | Monday, 2020-10-05 |

Figure 1. Consequences of the annual release cycle on the calendar.

```mermaid
gantt
  accTitle: Python 3.9 under the annual release cycle
  dateFormat YYYY-MM-DD
  section 3.9
  Unversioned development :2019-06-04, 2019-10-14
  Alpha releases          :2019-10-14, 2020-05-18
  Beta releases           :2020-05-18, 2020-08-10
  Release candidates      :2020-08-10, 2020-10-05
  section 3.10
  Development begins      :2020-05-18, 2020-10-05
```

In comparison, if this PEP is rejected and Python keeps the current release schedule:

```text
3.9 development begins: Tuesday, 2019-06-04
3.9.0 alpha 1: Monday, 2020-08-03  (10 months later)
3.9.0 alpha 2: Monday, 2020-09-07
3.9.0 alpha 3: Monday, 2020-10-05
3.9.0 alpha 4: Monday, 2020-11-02
3.9.0 beta 1: Monday, 2020-11-30  (6 months later)
3.9.0 beta 2: Monday, 2021-01-04
3.9.0 beta 3: Monday, 2021-02-01
3.9.0 beta 4: Monday, 2021-03-01
3.9.0 candidate 1: Monday, 2021-03-29
3.9.0 candidate 2: Monday, 2021-04-05 (if necessary)
3.9.0 final: Monday, 2021-04-19  (6 months later)
```

## Dependent Policies

### Deprecations

The current policy around breaking changes assumes at least two releases before a deprecated feature is removed from Python or a `__future__` behavior is enabled by default. This is documented in PEP 387.

This PEP proposes to keep this policy of **at least** two releases before making a breaking change.

### The term of the Release Manager

The current undocumented convention is for a single Release Manager to handle two feature releases of Python. This PEP proposes to keep this policy, allowing for the term to be extended to more releases with approval from the Steering Council and the Cabal of Release Managers.

## Rationale and Goals

This change provides the following advantages:

- makes releases smaller: since doubling the cadence doesn't double our available development resources, consecutive releases are going to be smaller in terms of features;
- puts features and bug fixes in hands of users sooner;
- creates a predictable calendar for releases where the final release is always in October (so after the annual core sprint), and the beta phase starts in late May (so after PyCon US sprints), which is especially important for core developers who need to plan to include Python involvement in their calendar;
- decreases the urge to rush features shortly before "Beta 1" due to the risk of them "slipping for 18 months".

### Non-goals

Adopting an annual release calendar allows for natural switching to calendar versioning, for example by calling Python 3.9 "Python 3.20" since it's released in October '20 and so on ("Python 3.23" would be the one released in October '23).

While the ease of switching to calendar versioning can be treated as an advantage of an annual release cycle, this PEP does not advocate for or against a change in how Python is versioned. Should the annual release cycle be adopted, the versioning question will be dealt with in a separate PEP. Undecided. Until that PEP is accepted, feature versions keep the 3.X numbering used in this document.

### Non-risks

This change does not shorten the currently documented support calendar for a Python release, both in terms of bugfix releases and security fixes.

This change does not accelerate the velocity of development. Python is not going to become incompatible faster or accrue new features faster. It's just that features are going to be released more gradually as they are developed.

### Risks

The "extended bugfix support at the discretion of the Release Manager" stage of the current release cycle is not codified. If fact, PEP 101 currently states that after the release of Python 3.(X+1).0 only one last bugfix release is made for Python 3.X.0. However, in practice at least the last four versions of Python 3 overlapped with stable releases of the next version for around six months.

### Rejected Ideas

#### Double the release cadence to achieve 9 months between feature versions

This was originally proposed in PEP 596 and rejected as both too irregular and too short. This would not give any of the benefits of a regular release calendar but it would shorten all development phases, especially the beta + RC phases. This was considered dangerous.

#### Long-Term Support Releases

Each version of Python is effectively long-term support: it's supported for five years, with the first eighteen months allowing regular bug fixes and security updates. For the remaining time security updates are accepted and promptly released.

No extended support in the vein of Python 2.7 is planned going forward.

## Update (October 2023): 2 years of full support, 3 more years of security fixes

This update replaces the 1½ year support calendar under Implementation for Python 3.13 and newer. After the release of Python 3.X.0, the 3.X series is maintained for five years:

- During the *first twenty four months* (2 years) it receives bugfix updates and full releases (sources and installers for Windows and macOS) are made approximately every other month.
- For the next *thirty six months* (3 years) it receives security updates and source-only releases are made on an as-needed basis (no fixed cadence).
- The final source-only release is made *five years* after 3.X.0.

Note: 2 years of full support start with Python 3.13 (PEP 719). Python versions 3.9 - 3.12 operate on a calendar with 1½ year of full support, followed by 3½ more years of security fixes.

## History

This section is for readers who want to know how the PEP got here. It is not needed to plan a release. PEP 602 was created on 04-Jun-2019 as an Informational PEP and accepted later that year, with Python 3.9 as the first version on the annual calendar. The 2023 update was discussed on 09-Oct-2023, and in 2024 the PEP was marked Active as a Process PEP.

Since this PEP is authored by the active Release Manager and its effect would shorten the term of the Release Manager, the author is open to managing the release of a third feature release to compensate for the disruption.
