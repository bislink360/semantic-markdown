# Rust project goals 2025H1: flagship goals and progress

Status: Accepted. [RFC #3764] has been **accepted**, establishing 40 total Rust project goals for 2025H1. This document combines the goal slate, the plans of the flagship goals and the goals that support them, and the March and April 2025 progress updates.

## Summary

Propose a slate of 40 project goals for 2025H1, including 3 flagship goals:

* Continue making Rust easier to use for network systems by [**bringing the Async Rust experience closer to parity with sync Rust**](#bring-the-async-rust-experience-closer-to-parity-with-sync-rust). In 2025H1 we plan to:
    * tell a complete story for the use of async fn in traits, unblocking wide ecosystem adoption;
    * improve the ergonomics of `Pin`, which is frequently used in low-level async code; and
    * prepare to support asynchronous (and synchronous) generators in the language.
* Continue helping Rust support low-level projects by [**stabilizing compiler options and tooling used by the Rust-for-Linux project**](#stabilize-tooling-needed-by-rust-for-linux). In 2025H1 we plan to:
    * implement [RFC #3716] to allow stabilizing ABI-modifying compiler flags to control code generation, sanitizer integration, and so forth;
    * taking the first step towards stabilizing [`build-std`](https://doc.rust-lang.org/cargo/reference/unstable.html#build-std) by [creating a stable way to rebuild core with specific compiler options](#build-std);
    * add rustdoc features to extract and customize rustdoc tests (`--extract-doctests`);
    * stabilize clippy configuration like `.clippy.toml` and `CLIPPY_CONF_DIR`;
    * stabilize compiler flags to extract dependency info (e.g., as via `-Zbinary-dep-depinfo=y`) and to configure no-std without requiring it in the source file (e.g., as via `-Zcrate-attr`);
* Address the biggest concerns raised by Rust maintainers, lack of face-to-face interaction, by [**organizing the Rust All-Hands 2025**](#organize-rust-all-hands-2025). In 2025H1 we plan to:
    * convene Rust maintainers to celebrate Rust's tenth birthday at [RustWeek 2025](https://2025.rustweek.org) (co-organized with [RustNL](https://2025.rustweek.org/about/));
    * author a first draft for a [Rust vision doc](#rust-vision-document) and gather feedback.

## Motivation

The 2025H1 goal slate consists of 40 project goals, of which we have selected 3 as **flagship goals**. Flagship goals represent the goals expected to have the broadest overall impact.

### How the goal process works

**Project goals** are proposed bottom-up by somebody who is willing to commit resources (time, money, leadership) to seeing the work get done (the **contact**). The contact identifies the problem they want to address and sketches the solution of how they want to do so. They also identify the support they will need from the Rust teams (typically things like review bandwidth or feedback on RFCs). Teams then read the goals and provide feedback. If the goal is approved, teams are committing to support the contact in their work.

Project goals can vary in scope from an internal refactoring that affects only one team to a larger cross-cutting initiative. No matter its scope, accepting a goal should never be interpreted as a promise that the team will make any future decision (e.g., accepting an RFC that has yet to be written). Rather, it is a promise that the team are aligned on the contents of the goal thus far (including the design axioms and other notes) and will prioritize giving feedback and support as needed.

Of the proposed goals, a small subset are selected by the roadmap owner as **flagship goals**. Flagship goals are chosen for their high impact (many Rust users will be impacted) and their shovel-ready nature (the org is well-aligned around a concrete plan). Flagship goals are the ones that will feature most prominently in our public messaging and which should be prioritized by Rust teams where needed.

```mermaid
flowchart LR
  A[Contact proposes a goal] --> B[Teams read the goal and give feedback]
  B --> C{Goal approved?}
  C -- yes --> D[Teams commit to support the contact]
  C -- no --> E[Goal not accepted]
  D --> F[Roadmap owner selects flagship goals]
```

### Rust's mission

Our goals are selected to further Rust's mission of **empowering everyone to build reliable and efficient software**. Rust targets programs that prioritize

* reliability and robustness;
* performance, memory usage, and resource consumption; and
* long-term maintenance and extensibility.

We consider "any two out of the three" as the right heuristic for projects where Rust is a strong contender or possibly the best option.

### Axioms for selecting goals

We believe that...

* **Rust must deliver on its promise of peak performance and high reliability.** Rust's maximum advantage is in applications that require peak performance or low-level systems capabilities. We must continue to innovate and support those areas above all.
* **Rust's goals require high productivity and ergonomics.** Being attentive to ergonomics broadens Rust impact by making it more appealing for projects that value reliability and maintenance but which don't have strict performance requirements.
* **Slow and steady wins the race.** We don't want to create stress via unrealistic, ambitious goals. We want to make steady progress each goal period on important problems.

## Flagship goals

### Why these particular flagship goals?

**Async.** This work continues our drive to improve support for async programming in Rust. In 2024H2 we stabilized async closures; explored the generator design space; and began work on the `dynosaur` crate, an experimental proc-macro to provide dynamic dispatch for async functions in traits. In 2025H1 our plan is to deliver (1) improved support for async-fn-in-traits, completely subsuming the functionality of the [`async-trait` crate](https://crates.io/crates/async-trait); (2) progress towards sync and async generators, simplifying the creation of iterators and async data streams; (3) and improve the ergonomics of `Pin`, making lower-level async coding more approachable. These items together start to unblock the creation of the next generation of async libraries in the wider ecosystem, as progress there has been blocked on a stable solution for async traits and streams.

**Rust for Linux.** This goal continues our work from 2024H2 in supporting the [experimental support for Rust development in the Linux kernel][RFL.com]. Whereas in 2024H2 we were focused on stabilizing required language features, our focus in 2025H1 is stabilizing compiler flags and tooling options. We will (1) implement [RFC #3716] which lays out a design for ABI-modifying flags; (2) take the first step towards stabilizing [`build-std`](https://doc.rust-lang.org/cargo/reference/unstable.html#build-std) by creating a stable way to rebuild core with specific compiler options; (3) extend rustdoc, clippy, and the compiler with features that extract metadata for integration into other build systems (in this case, the kernel's build system).

**Rust All Hands 2025.** May 15, 2025 marks the 10-year anniversary of Rust's 1.0 release; it also marks 10 years since the [creation of the Rust subteams](https://internals.rust-lang.org/t/announcing-the-subteams/2042). At the time [there were 6 Rust teams with 24 people in total](http://web.archive.org/web/20150517235608/http://www.rust-lang.org/team.html). There are now 57 teams with 166 people. In-person All Hands meetings are an effective way to help these maintainers get to know one another with high-bandwidth discussions. This year, the Rust project will be coming together for [RustWeek 2025](https://2025.rustweek.org), a joint event organized with [RustNL](https://2025.rustweek.org/about/). Participating project teams will use the time to share knowledge, make plans, or just get to know one another better. One particular goal for the All Hands is reviewing a draft of the Rust Vision Doc, a document that aims to take stock of where Rust is and lay out high-level goals for the next few years.

### Project goals

The full slate of project goals are as follows. These goals all have identified owners who will drive the work forward as well as a viable work plan. The goals include asks from the listed Rust teams.

> Just because a goal is listed on this list does not mean the goal has been accepted.
> The owner of the goal process makes the final decisions on which goals to include
> and prepares an RFC to ask approval from the teams.

**Invited goals.** Some goals of the goals below are "invited goals", meaning that for that goal to happen we need someone to step up and serve as an owner. To find the invited goals, look for the "Help wanted" badge in the goal tables. Invited goals have reserved capacity for teams and a mentor, so if you are someone looking to help Rust progress, they are a great way to get involved.

### Definitions

Definitions for terms used in the goal tables:

* *Discussion and moral support* is the lowest level offering, basically committing the team to nothing but good vibes and general support for this endeavor.
* *Author RFC* and *Implementation* means actually writing the code, document, whatever.
* *Design meeting* means holding a synchronous meeting to review a proposal and provide feedback (no decision expected).
* *RFC decisions* means reviewing an RFC and deciding whether to accept.
* *Org decisions* means reaching a decision on an organizational or policy matter.
* *Secondary review* of an RFC means that the team is "tangentially" involved in the RFC and should be expected to briefly review.
* *Stabilizations* means reviewing a stabilization and report and deciding whether to stabilize.
* *Standard reviews* refers to reviews for PRs against the repository; these PRs are not expected to be unduly large or complicated.
* *Prioritized nominations* refers to prioritized lang-team response to nominated issues, with the expectation that there will be *some* response from the next weekly triage meeting.
* *Dedicated review* means identifying an individual (or group of individuals) who will review the changes, as they're expected to require significant context.
* Other kinds of decisions:
    * [Lang team experiments](https://lang-team.rust-lang.org/how_to/experiment.html) are used to add nightly features that do not yet have an RFC. They are limited to trusted contributors and are used to resolve design details such that an RFC can be written.
    * Compiler [Major Change Proposal (MCP)](https://forge.rust-lang.org/compiler/mcp.html) is used to propose a 'larger than average' change and get feedback from the compiler team.
    * Library [API Change Proposal (ACP)](https://std-dev-guide.rust-lang.org/development/feature-lifecycle.html) describes a change to the standard library.

# Bring the Async Rust experience closer to parity with sync Rust

| Metadata | |
|:-|-|
| Short title | Async |
| Contact | @tmandry |
| Status | Accepted |
| Flagship | Yes |
| Tracking issue | rust-lang/goals#105 |
| Zulip channel | [#wg-async](https://rust-lang.zulipchat.com/#narrow/channel/187312-wg-async/) |

## Summary

Over the next six months, we will continue bringing Async Rust up to par with "sync Rust" by doing the following:

* Telling a complete story for the use of async fn in traits, unblocking wide ecosystem adoption,
* Improving the ergonomics of `Pin`, which is frequently used in low-level async code, and
* Preparing to support asynchronous (and synchronous) generators in the language.

## Motivation

This goal represents the next step on a multi-year program aiming to raise the experience of authoring "async Rust" to the same level of quality as "sync Rust". Async Rust is a crucial growth area, with 52% of the respondents in the [2023 Rust survey](https://blog.rust-lang.org/2024/02/19/2023-Rust-Annual-Survey-2023-results.html) indicating that they use Rust to build server-side or backend applications.

### The status quo

Async Rust is the most common Rust application area according to our [2023 Rust survey](https://blog.rust-lang.org/2024/02/19/2023-Rust-Annual-Survey-2023-results.html). Rust is a great fit for networked systems, especially in the extremes:

* **Rust scales up**. Async Rust reduces cost for large dataplanes because a single server can serve high load without significantly increasing tail latency.
* **Rust scales down.** Async Rust can be run without requiring a garbage collector or [even an operating system][embassy], making it a great fit for embedded systems.
* **Rust is reliable.** Networked services run 24/7, so Rust's "if it compiles, it works" mantra means fewer unexpected failures and, in turn, fewer pages in the middle of the night.

Despite async Rust's popularity, using async I/O makes Rust significantly harder to use. As one Rust user memorably put it, "Async Rust is Rust on hard mode." Several years back the async working group collected a number of ["status quo" stories](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo.html) as part of authoring an async vision doc. These stories reveal a number of characteristic challenges:

* Common language features do not support async, meaning that [users cannot write Rust code in the way they are accustomed to](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/barbara_plays_with_async.html?highlight=closure#the-story):
  * ~~[traits](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/alan_needs_async_in_traits.html)~~ (they [do now][afitblog], though gaps remain)
  * ~~closures~~ ([stabilized](https://github.com/rust-lang/rust/pull/132706))
  * [drop](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/alan_finds_database_drops_hard.html)

  In many cases there are workarounds or crates that can close the gap, but users have to learn about and find those crates.
* Common async idioms have "sharp edges" that lead to unexpected failures, forcing users to manage [cancellation safety](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/barbara_gets_burned_by_select.html), subtle [deadlocks](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/aws_engineer/solving_a_deadlock.html) and other failure modes for [buffered streams](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/barbara_battles_buffered_streams.html). See also tmandry's blog post on [Making async Rust reliable](https://tmandry.gitlab.io/blog/posts/making-async-reliable/)).
* Using async today requires users to select a runtime which provides many of the core primitives. Selecting a runtime as a user [can be stressful](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/barbara_makes_their_first_steps_into_async.html#the-wrong-time-for-big-decisions), as the [decision once made is hard to reverse](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/barbara_wishes_for_easy_runtime_switch.html). Moreover, in an attempt to avoid "picking favorites", the project has not endorsed a particular runtime, making it [harder to write new user documentation](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/niklaus_wants_to_share_knowledge.html). Libraries meanwhile [cannot easily be made interoperable across runtimes](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/barbara_writes_a_runtime_agnostic_lib.html) and so are often written against the API of a particular runtime; even when libraries can be retargeted, it is difficult to do things like run their test suites to test compatibility. [Mixing and matching libraries can cause surprising failures.](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/alan_started_trusting_the_rust_compiler_but_then_async.html)

### The next 6 months

#### Tell a complete story for async fn in traits

* Unblock AFIT in public traits by stabilizing RTN and implementable trait aliases (unblock tower 1.0)
* Ship 1.0 of the dynosaur crate, enabling dynamic dispatch with AFIT
* Stretch goal: Implement experimental support for async fn in `dyn Trait` in nightly

#### Improve ergonomics around `Pin`

* Ratify and implement an RFC for auto-reborrowing of pinned references
* Stretch goal: Discuss and implement a design for safe pin projection

#### Work toward asynchronous generators

* Have design meetings and ratify an RFC for a syntax for authoring synchronous iterators (e.g., synchronous generators)
* Stretch goal: Ratify an RFC for unsafe binders

In H2 we hope to tackle the following:

* RTN in type position
* Ratified RFC for syntactic support for asynchronous iteration

### The "shiny future" we are working towards

**Writing async code in Rust should feel just as expressive, reliable, and productive as writing sync code in Rust.** Our eventual goal is to provide Rust users building on async with

* the same core language capabilities as sync Rust (async traits with dyn dispatch, async closures, async drop, etc);
* reliable and standardized abstractions for async control flow (streams of data, error recovery, concurrent execution), free of accidental complexity;
* an easy "getting started" experience that builds on a rich ecosystem;
* good performance by default, peak performance with tuning;
* the ability to easily adopt custom runtimes when needed for particular environments, language interop, or specific business needs.

## Design axioms

* **Uphold sync Rust's bar for reliability.** Sync Rust famously delivers on the general feeling of "if it compiles, it works" -- async Rust should do the same.
* **Lay the foundations for a thriving ecosystem.** The role of the Rust org is to develop the rudiments that support an interoperable and thriving async crates.io ecosystem.
* **When in doubt, zero-cost is our compass.** Many of Rust's biggest users are choosing it because they know it can deliver the same performance (or better) than C. If we adopt abstractions that add overhead, we are compromising that core strength. As we build out our designs, we ensure that they don't introduce an "abstraction tax" for using them.
* **From embedded to GUI to the cloud.** Async Rust covers a wide variety of use cases and we aim to make designs that can span those differing constraints with ease.
* **Consistent, incremental progress.** People are building async Rust systems *today* -- we need to ship incremental improvements while also steering towards the overall outcome we want.

## Ownership and team asks

This section defines the specific work items that are planned and who is expected to do them. It should also include what will be needed from Rust teams. The overall owner of the effort is @tmandry. We have identified owners for subitems below; these may change over time.

### Overall program management

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| AFIT story blog post | @tmandry | |

### Return type notation

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Initial implementation | @compiler-errors | Complete |
| Author RFC | @nikomatsakis | Complete |
| RFC decision | Team: lang | Complete |
| Finished implementation | @compiler-errors | Complete |
| Standard reviews | Team: types, compiler | |
| Author stabilization report | @compiler-errors | |
| Author Reference PR | TBD (@compiler-errors, @tmandry, or @nikomatsakis) | |
| Review/revise Reference PR | Team: lang-docs | @nikomatsakis |
| Stabilization decision | Team: lang, types | |

### Unsafe binders

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Initial implementation | @compiler-errors | Stretch goal |
| Author RFC | @nikomatsakis | Stretch goal |
| RFC decision | Team: lang, types | Stretch goal |

### Implementable trait aliases

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Author RFC | @tmandry | |
| Implementation | @compiler-errors | |
| Standard reviews | Team: types, compiler | |
| RFC decision | Team: lang, types | |

### `async fn` in `dyn Trait`

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Lang-team experiment | @nikomatsakis | (Approved) |
| Implementation | @compiler-errors | Stretch goal |

### Pin ergonomics

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Implementation | @eholk | |
| Author RFC | @eholk | |
| Lang-team experiment | Team: lang | Complete |

### Trait for generators (sync)

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Implementation | @eholk | |
| Author RFC | | |
| RFC decision | Team: libs, lang | |
| Design meeting | Team: lang | 2 meetings expected |

### Dynosaur 1.0

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Implementation | @spastorino | |
| Standard reviews | @tmandry | |

## Frequently asked questions

### Why work on synchronous generators if your goal is to support async?

There are three features we want that all interact quite heavily with each other:

* Sync generators
* Async generators
* Async iteration trait

Of the three, we think we are the closest to ratifying an RFC for synchronous generators. This should help clarify one of the major outstanding questions for the other two items; namely, the relation to pinning. With that out of the way, we should better be able to focus on the iteration trait and how well it works with async generators.

Focusing on pinning first also synergizes well with the efforts to improve the ergonomics of pinning.

# Stabilize tooling needed by Rust for Linux

| Metadata | |
|:-|-|
| Short title | Rust-for-Linux |
| Contact | @nikomatsakis |
| Status | Accepted |
| Flagship | Yes |
| Tracking issue | rust-lang/goals#116 |
| Zulip channel | [#rust-for-linux](https://rust-lang.zulipchat.com/#narrow/channel/425075-rust-for-linux/) |

## Summary

Continue working towards Rust for Linux on stable, turning focus to compiler and tooling.

## Motivation

This goal continues our push to support the Linux kernel building on stable Rust. The focus in 2025H1 is shifting from language features, which were largely completed in 2024H2, towards compiler flags and tooling support. The Linux Kernel makes use of a [number of unstable options][RFL#2] in the compiler for target specific optimizations, code hardening, and sanitizer integration. It also requires a custom build of the standard library and has hacky integration with rustdoc to enable the use of doctests. We are looking to put all of these items onto a stable foundation.

### The status quo

The [Rust for Linux (RFL)][RFL.com] project has been accepted into the Linux kernel in experimental status. The project's goal, as described in the Kernel RFC introducing it, is to add support for authoring kernel components (modules, subsystems) using Rust. Rust would join C as the only two languages permitted in the Linux kernel. This is a very exciting milestone for Rust, but it's also a big challenge.

Integrating Rust into the Linux kernel means that Rust must be able to interoperate with the kernel's low-level C primitives for things like locking, linked lists, allocation, and so forth. This interop requires Rust to expose low-level capabilities that don't currently have stable interfaces.

The Rust side of the kernel needs to support [a range of compiler versions](https://rust-for-linux.com/rust-version-policy), just like the C side does. For instance, distributions wish to be able to build a range of kernel sources with the same compiler, rather than having to select a particular toolchain for a particular kernel version. Thus RFL is already declaring an MSRV. Because unstable features have no kind of reliability guarantee, this in turn means that it is a priority to remove the dependency on unstable features so that Linux can be built with future Rust compilers without major changes on the kernel side.

Longer term, having Rust in the Linux kernel is an opportunity to expose more C developers to the benefits of using Rust. But that exposure can go both ways. If Rust is constantly causing pain related to toolchain instability, or if Rust isn't able to interact gracefully with the kernel's data structures, kernel developers may have a bad first impression that causes them to write off Rust altogether. We wish to avoid that outcome. And besides, the Linux kernel is exactly the sort of low-level systems application we want Rust to be great for!

For deeper background, please refer to these materials:

* The article on the latest Maintainers Summit: [Committing to Rust in the kernel](https://lwn.net/Articles/991062/)
* The [LWN index on articles related to Rust in the kernel](https://lwn.net/Kernel/Index/#Development_tools-Rust)
* [The latest status update at LPC](https://www.youtube.com/watch?v=tamydDnWoLs).
* [Linus talking about Rust](https://www.youtube.com/watch?v=OvuEYtkOH88&t=335s).
* [Rust in the linux kernel, by Alice Ryhl](https://www.youtube.com/watch?v=CEznkXjYFb4)
* [Using Rust in the binder driver, by Alice Ryhl](https://www.youtube.com/watch?v=Kt3hpvMZv8o)

### What we have done so far

We began the push towards stable support for RFL in 2024H2 with [a project goal focused on language features](https://github.com/rust-lang/goals/issues/116). Over the course of those six months we:

* Stabilized the `CoercePointee` derive, supporting the kernel's use of smart pointers to model intrusive linked lists.
* Stabilized basic usage of `asm_goto`. Based on a survey of the kernel's usage, we [modified the existing design](https://github.com/rust-lang/rust/issues/132078) and also proposed [two](https://github.com/rust-lang/rust/issues/128464) [extensions](https://github.com/rust-lang/rust/pull/131523).
* Stabilized `offset_of` syntax applied to structs.
* Added Rust-for-Linux to the Rust CI to avoid accidental breakage.
* Stabilized support for pointers to static in constants.

The one feature which was not stabilized yet is [arbitrary self types v2][astv2], which reached "feature complete" status in its implementation. Stabilization is expected in early 2025.

We also began work on tooling stabilization with an [RFC proposing an approach to stabilizing ABI-modifying compiler flags](https://github.com/rust-lang/rfcs/pull/3716).

### The next six months

Over the next six months our goal is to stabilize the major bits of tooling used by the Rust for Linux project. Some of these work items are complex enough to be tracked independently as their own project goals, in which case they are linked.

* implementing [RFC #3716] to allow stabilizing ABI-modifying compiler flags to control code generation, sanitizer integration, and so forth
* the ability to extract dependency info and to configure no-std without requiring it in the source file:
    * currently using `-Zbinary_dep_depinfo=y` and `-Zcrate-attr`
* stable rustdoc features allowing the RFL project to extract and customize rustdoc tests (`--extract-doctests`);
* clippy configuration (possibly `.clippy.toml` and `CLIPPY_CONF_DIR`);
* [a blessed way to rebuild std](#build-std): RFL needs a way to rebuild the standard library using stable calls to rustc. Currently building the standard library with rustc is not supported. This is a precursor to what is commonly called `-Zbuild-std`; it is also a blocker to making full use of API-modifying compiler flags and similar features, since they can't be used effectively unless the kernel is rebuilt.

In addition, as follow-up from 2024H2, we wish to complete [arbitrary self types v2][astv2] stabilization.

### The "shiny future" we are working towards

The ultimate target for this line of work is that Rust code in the Linux kernel builds on stable Rust with a Minimum Supported Rust Version (MSRV) tied to some external benchmark, such as Debian stable. This is the minimum requirement for Rust integration to proceed from an "experiment" so something that could become a permanent part of Linux.

Looking past the bare minimum, the next target would be making "quality of life" improvements that make it more ergonomic to write Rust code in the kernel (and similar codebases). One such example is the proposed experiment for field projections.

## Design axioms

* **First, do no harm.** If we want to make a good first impression on kernel developers, the minimum we can do is fit comfortably within their existing workflows so that people not using Rust don't have to do extra work to support it. So long as Linux relies on unstable features, users will have to ensure they have the correct version of Rust installed, which means imposing labor on all Kernel developers.
* **Don't let perfect be the enemy of good.** The primary goal is to offer stable support for the particular use cases that the Linux kernel requires. Wherever possible we aim to stabilize features completely, but if necessary, we can try to stabilize a subset of functionality that meets the kernel developers' needs while leaving other aspects unstable.

## Ownership and team asks

Here is a detailed list of the work to be done and who is expected to do it. This table includes the work to be done by owners and the work to be done by Rust teams (subject to approval by the team in an RFC/FCP).

* The "Team" badge indicates a requirement where Team support is needed.

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Discussion and moral support | Team: compiler, rustdoc, cargo | |
| Overall program management | @nikomatsakis | |

### ABI-modifying compiler flags

Goal: stabilizing various ABI-modifying flags such as `-Zbranch-protection` and friends.

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Author RFC | @darksonn | Completed |
| RFC decision | Team: compiler | [RFC #3716], currently in PFCP |
| Implementation | Help wanted | For each flag, need to move flags from `-Z` to `-C` etc |
| Standard reviews | Team: compiler | |
| Stabilization decision | Team: compiler | For each of the relevant compiler flags |

### Extract dependency information, configure no-std externally

Goal: support extraction of dependency information (similar to `-Zbinary_dep_depinfo=y` today) and ability to write crates without explicit, per-crate `![no_std]` (achieved via `-Zcrate-attr` today).

Right now there is no plan for how to approach this. This task needs an owner to pick it up, make a plan, and execute.

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Author a plan | Help wanted | |
| Implementation | Help wanted | |
| Standard reviews | Team: compiler | |
| Stabilization decision | Team: compiler | |

### Rustdoc features to extract doc tests

Goal: stable rustdoc features sufficient to extract doc tests without hacky regular expressions

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Author RFC | Help wanted | |
| RFC decision | Team: rustdoc | |
| Implementation | Help wanted | |
| Standard reviews | Team: rustdoc | |
| Stabilization decision | Team: rustdoc | |

### Clippy configuration

Goal: stabilized approach to customizing clippy (like `.clippy.toml` and `CLIPPY_CONF_DIR` today).

As discussed on [Zulip](https://rust-lang.zulipchat.com/#narrow/channel/257328-clippy/topic/stablization.20of.20clippy.2Etoml.20a), the relevant policy is already correct, but documentation is needed.

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Author documentation | Help wanted | |
| Stabilization decision | Team: clippy | |

### Blessed way to rebuild std

See the [build-std](#build-std) goal.

## Frequently asked questions

### What kind of compiler flags will Rust-for-Linux need?

Implementing [RFC #3716], coupled with a [blessed way to build std](#build-std), will allow the full use of flags that modify the ABI. We will need to ultimately stabilize the full set of flags used by RFL, which include at least the following:

* arm64: `-Zbranch-protection`, `-Zfixed-x18`, `-Zuse-sync-unwind`.
* x86: `-Zcf-protection`, `-Zfunction-return`, `-Zno-jump-tables`, `-Zpatchable-function-entry`, retpoline (`+retpoline-external-thunk,+retpoline-indirect-branches,+retpoline-indirect-calls`), SLS (`+harden-sls-ijmp,+harden-sls-ret`).
* x86 32-bit: `-Zregparm=3`, `-Zreg-struct-return`.
* LoongArch: `-Zdirect-access-external-data`.
* production sanitizer flags: `-Zsanitizer=shadow-call-stack`, `-Zsanitizer=kcfi`, `-Zsanitizer-cfi-normalize-integer`.

Stabilization decisions for each flag will be made independently. We will likely take a future goal to drive some percentage of them to stabilization once [RFC #3716] is implemented.

# build-std

| Metadata | |
| :-- | :-- |
| Contact | @davidtwco |
| Status | Accepted |
| Zulip channel | N/A |
| Tracking issue | rust-lang/goals#274 |

*Arm's Rust team is @davidtwco, @adamgemmell, @jacobbramley, @JamieCunliffe and @Jamesbarford. This goal will be primarily worked on by @adamgemmell, but @davidtwco can always be contacted for updates.*

## Summary

Write an RFC for a minimum viable product (MVP) of build-std which has the potential to be stabilised once implemented (as opposed to the currently implemented MVP which is only suitable for experimentation and testing), and then implement it.

## Motivation

build-std is a well-known unstable feature in Cargo which enables Cargo to re-build the standard library, this is useful for a variety of reasons:

- Building the standard library for targets which do not ship with a pre-compiled standard library.
- Optimising the standard library for known hardware, such as with non-baseline target features or options which optimise for code size. This is a common use case for embedded developers.
- Re-building the standard library with different configuration options (e.g. changing the optimisation level, using flags which change the ABI, or which add additional exploit mitigations).
- Re-building the standard library with different `cfg`s (e.g. disabling `backtrace` in std), to the extent that such configurations are supported by the standard library.
- Stabilisation of various compiler flags which change the ABI, add additional exploit mitigations (such as `-Zsanitizers=cfi` or `-Zbranch-protection`), or which otherwise only make sense to use when the entire program is compiled with the flag (including std) is blocked on these being unable to be used properly without being able to rebuild std.

These features are more useful for some subsets of the Rust community, such as embedded developers where optimising for size can be more important and where the targets often don't ship with a pre-compiled std.

The fifty-thousand foot view of the work involved in this feature is:

- Having the standard library sources readily available that match the compiler.
- Being able to build those sources without using a nightly toolchain, which has many possible solutions.
- Having a blessed way to build at least `core` without Cargo, which some users like Rust for Linux would like.
  - This would be optional but may be a side-effect of whatever mechanism for build-std the MVP RFC eventually proposes.
- Being able to tell the compiler to use the resulting prebuilt standard library sources instead of the built-in standard library, in a standard way.
- Integrating all of the above into Cargo.
- Making sure all of this works for targets that don't have a pre-built std.

Rust for Linux and some other projects have a requirement to build core themselves without Cargo (ideally using the same stable compiler they use for the rest of their project), which is a shared requirement with build-std, as whatever mechanism these projects end up using could be re-used by the implementation of build-std and vice-versa.

### The status quo

build-std is currently an unstable feature in Cargo which hasn't seen much development or progress since its initial development in 2019/2020. There are a variety of issues in the [wg-cargo-std-aware](https://github.com/rust-lang/wg-cargo-std-aware) repository which vary from concrete bugs in the current experimental implementation to vague "investigate and think about this" issues, which make the feature difficult to make progress on.

Some of the work required for this exists in the current perma-unstable `-Zbuild-std` implementation, which may be re-used if appropriate. Today it can only be used from a nightly toolchain, for example:

```console
$ cargo +nightly build -Zbuild-std --target x86_64-unknown-linux-gnu
```

Prior to the submission of this goal, this goal has been discussed with the cargo team and leads of the compiler and library teams, ensuring that this goal's owners have liaisons from stakeholder teams and the support of the primary teams involved in the design and implementation.

### The next 6 months

There are two primary objectives of this goal in its first six months:

- Firstly, we will write an MVP RFC that will limit the scope of the feature and make it easier to make progress on build-std.

  It is intended that this RFC will summarize all of the previous discussion, use cases and feedback on build-std. In this documenting of the current state of build-std, this RFC will be well-positioned to propose which use cases should and should not be resolved by build-std (for the final feature, not just this MVP). For example, this RFC will decide whether patching or modifying std is a supported use case for build-std.

  For those use cases solved by build-std, the RFC will select a subset for the new MVP of build-std. It is intended that this MVP be sufficiently useful and complete that it could be stabilised. The design of the MVP will be forward-compatible with all of the other use cases that build-std is intended to solve.

  It is hoped that this RFC should demonstrate a thorough understanding of the design space of build-std and give the responsible upstream teams confidence in our ownership of this feature, and enabling those teams to make a fully informed decision on any proposals made.

- Next, after and conditional on acceptance of this RFC, we will proceed with its implementation.

### The "shiny future" we are working towards

After the approval and implementation of the MVP RFC, there will naturally be follow-up use cases which can be designed and implemented to complete the build-std feature.

## Design axioms

- Enabling build-std without changing any compilation options or configuration should produce an equivalent library to that distributed by the project.
- Avoid precluding future extensions to build-std.
- build-std should allow std/alloc/core to be treated more like other dependencies than currently.
  - This represents a general move away from treating std/alloc/core as a special case.

## Ownership and team asks

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Discussion and moral support | Team: cargo | |
| Author RFC | @adamgemmell | |
| Implementation | @adamgemmell | |
| Standard reviews | Team: cargo | |

## Frequently asked questions

None yet.

# Organize Rust All-Hands 2025

| Metadata | |
| :-- | :-- |
| Contact | @m-ou-se |
| Status | Accepted |
| Flagship | Yes |
| Zulip channel | N/A |
| Tracking issue | rust-lang/goals#263 |

## Summary

Organise another Rust All-Hands in 2025!

## Motivation

It's been too long since we've had a Rust All-Hands. Time to bring it back!

### The status quo

Previous Rust All-Hands events were very useful and successful, but after the changes at Mozilla, we haven't had a Rust All-Hands in six years. Meanwhile, the project has grown a lot, making it much harder and expensive to organise a new Rust All-Hands.

A few months ago, when Jack brought up having a new Rust All-Hands in the Leadership Council meeting, Mara proposed having the new Rust All-Hands at [RustWeek 2025](https://2025.rustweek.org) by [RustNL](https://2025.rustweek.org/about/), which will take place in the Netherlands around the 10th birthday of Rust 1.0. Both RustNL and the Rust Leadership Council agreed.

See https://blog.rust-lang.org/inside-rust/2024/09/02/all-hands.html

### The next 6 months

- Prepare the all-hands and everything around it.
- Have a social and informal "pre-all hands day" on Rust's 10th birtday: May 15, 2025.
- Have a two-day all-hands on May 16 and May 17, 2025.
- During the all hands, coordinate reviews of the proposed [Rust Vision Doc](#rust-vision-document)

### The "shiny future" we are working towards

The immediate goal is a very successful and productive Rust All-Hands 2025. Hopefully, this will be the first step towards the larger goal of having regular Rust All-Hands again.

We should be able to use the feedback and lessons learned from this event for the next ones, and to figure out what the right frequency would be (yearly or less often). Repeating an event tends to be much easier than organising one from scratch.

## Design axioms

- Accessibility. Ideally, everyone in the project should be able to attend the Rust All-Hands
- Productivity and effectivity. We should optimally make use of the event, to make it worth everyone's time.
- Low stress. The event or the planning of it should not burn anyone out. It is a tool to help the project and its members, after all!
- Space for social events. The goal is not just to work on technical things together, but also to get to know each other and become a closer team.

## Ownership and team asks

**Owner:** Mara

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Pick the dates | RustNL, leadership-council | Complete |
| Allocate funds | Team: leadership-council | Complete for event |
| Allocate funds | Rust Foundation | Complete for travel |
| Book the venue | RustNL | Complete |
| Catering / snacks / food / drinks | RustNL | Complete |
| Register for the Rust All-Hands 2025 | *every project member* | Majority already signed up! |
| Send out conformations/tickets | @m-ou-se | |
| Send out detailed information | @m-ou-se | |
| Answer logistical questions | @m-ou-se | |
| Interface between project and RustNL | @m-ou-se | |
| Make hotel reservations | RustNL | In progress |
| Book hotel | *all participants* | RustNL will provide suggestions |
| Book travel | *all participants* | |
| Miscellaneous | Team: leadership-council | Prepare one or two plenary sessions |
| Submit talks for the "Rust Project Track" | *project members* | Possibility to give talks at the conference before the all-hands. |
| Moderation / safety | RustNL and moderator team | |
| Accessibility and covid safety | RustNL | |
| Come to the Rust All-Hands 2025 | *all participants* | |
| Reimburse travel costs | Rust Foundation | |

### Team swag

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Miscellaneous | Team: leadership-council | Decide on team swag; suggestions very welcome! |
| Acquire swag | RustNL | |

### Make plans for what to do at the all-hands

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Gather input from your teams | *team leads* (or delegate) | |
| Provide input for planning team | *team leads* (or delegate) | |
| Make an agenda for your team's room | *team leads* (or delegate) | |
| Coordinate the overall process | Planning team | Small group of 2-3 people. Volunteers welcome! |
| Make a room plan (after gathering input) | Planning team | |

### Organise an optional "pre all-hands day"

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Organisation | @m-ou-se, RustNL | An optional day without an agenda, with space for social activities |
| Acquire gifts (secret!) | @m-ou-se | Complete |

## Frequently asked questions

### I'm so excited about the all hands!

Me too!

### How will we schedule meetings?

@jackh726 asked:

> The key challenge here is going to be scheduling meetings for teams with overlapping membership. Likely it'll probably make sense to stagger team meetings such that there are blocks of time with very few overlaps of "official" meetings (with the acknowledgement that maybe that means during those times the parallelism goes down).

@m-ou-se answered:

> Yeah that's part of the reason for a "Planning team" to "Coordinate the overall process". Hopefully we can make the draft agendas public early so teams can work together directly to align their plans a bit. It's going to be a fun puzzle though. ^^

### Who can attend?

@jackh726 asked:

> One thing I haven't seen listed is who other than the Project is/may attend? From what I remember, there is a separate space available - it would be really good to have an actual list for that, which is available to Project members, since people may be interested in chatting/coordinating.

@m-ou-se answered:

> There will be an unconference at the same venue that will host groups like the embedded working group, Rust for Linux, Bevy maintainers, UI/App developers, and a few other groups. That part is handled by RustNL as a mostly separate event, that just happens to take place in the same location.
>
> RustNL will of course share which groups that will be once they confirm, so we can coordinate potential collaboration with these groups. But from a organisation (and funding) perspective, we treat the all-hands and the unconference as mostly separate events, which is why I didn't include it in the project goal.

# Rust Vision Document

| Metadata | |
| :-- | :-- |
| Contact | @nikomatsakis |
| Status | Accepted |
| Zulip channel | N/A |
| Tracking issue | rust-lang/goals#269 |

## Summary

Present a first draft of a "Rust Vision Doc" at the Rust All Hands in May.

The Rust Vision Doc will summarize the state of Rust adoption -- where is Rust adding value? what works well? what doesn't? -- based on conversations with individual Rust users from different communities, major Rust projects, and companies large and small that are adopting Rust. It will use that raw data to make recommendations on what problems Rust should be attacking and what constraints we should be trying to meet. The document will not include specific features or recommendations, which ought to be legislated through RFCs.

## Motivation

The goal is to author a longer term "vision doc" that identifies key opportunities for Rust over the next 3-5 years. The document will help us focus our energies and attack problems that move the needle for Rust.

### Rust's planning processes have a 6 month time window

Rust's official planning processes are currently scoped at the 6 month horizon (project goals). Of course a number of longer term initiatives are in play, some quite long indeed, such as the long drive towards a better async experience or towards parallel compilation. This planning primarily lives in the heads of the maintainers doing the work. There is no coordinated effort to collect the experiences of Rust users in a larger way.

#### It's time for us to think beyond "adoption"

Rust's goal since the beginning has been to *empower everyone to build reliable and efficient software*. We wanted Rust to be a language that would enable more people to build more things more quickly than was possible before. And not just any things, but things that worked well, saved resources, and lasted a long time. This is why Rust prizes performance, reliability, productivity, and long-term maintenance.

Once the basic design of Rust had come into focus, it was clear that our primary goal was focusing on adoption. But now that Rust has established a foothold in the industry, adoption on its own is not clearly the right goal for us. Rust, like most any general purpose language, can be used for all kinds of things. What are the kinds of applications where Rust is already a *great fit*, and how could it get even better? And what are the kinds of applications where Rust *could be* a great fit, if we overcame some obstacles?

#### Background: to know where to go, you have to know where you are

The biggest effort towards central planning was the authoring of the [Async Vision Doc], which took place in 2021. The Async Vision Doc effort began by collecting [status quo][] stories described the experiences of using async in a number of scenarios based on a [cast of four characters][]: Alan, Grace, Niklaus, and Barbara. These stories were "crowd sourced" over several months, during which time we held video chats and interviews.

Writing the "status quo" stories helped us to compensate for the [curse of knowledge][CoK]: the folks working on Async Rust tended to be experts in Async Rust, familiar with the the little tips and tricks that can get you out of a jam. The stories helped us to see the impact from [little](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/alan_started_trusting_the_rust_compiler_but_then_async.html) [paper](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/alan_needs_async_in_traits.html) [cuts](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/alan_thinks_he_needs_async_locks.html) that we had long since overlooked, while also identifying [deeper challenges](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/barbara_battles_buffered_streams.html) and [blockers](https://rust-lang.github.io/wg-async/vision/submitted_stories/status_quo/alan_finds_database_drops_hard.html).

#### Gathering stories from both individuals and groups

Gathering stories from individuals can be done with the same techniques we used with the Async Vision Doc, like online meetings and soliciting PRs. We may also be able to coordinate with Rust conferences.

For the broader Rust vision doc, we would also like to proactively seek input from groups that we think would have useful context:

* Rust trainers and consultants;
* groups driving adoption at companies;
* groups like the Rust Foundation.

#### Focus on *opportunities* and *requirements* instead of a specific "shiny future"

After the Status Quo story gathering, the Async Vision Doc attempted to author a [shiny future]. The intent was to align the community around a single vision but (in the opinion of the author, myself) it was not especially successful. There are several reasons for this. For one, the document was never RFC'd, which meant it did not truly represent a consensus. Second, it attempted to paint a more precise picture than was truly possible. The design of new features in complex domains like async is subject to a "fog of war effect": the immediate next steps can be relatively clear, and perhaps the end point is even somewhat understood, but the path between will have to figured out as you go. Trying to author a shiny future is inherently challenging.

For the Rust Vision Doc, we plan to take a different approach. Rather than authoring a shiny future, we will identify specific *opportunities*-- places where we believe Rust could have a huge impact on the state of software development. For each of those, we'll make recommendations about the kinds of problems that need to be solve for Rust to be truly successful in those domains. We will back up those recommendations with references to status quo stories and other data.

### The next 6 months

Our goal for the next 6 months is to present a first draft of the vision doc at the Rust All Hands, planned for May 2025. We will use this opportunity to get feedback on the doc structure and recommendations and to begin work on the actual RFC, excepted to be accepted in 2025H2.

Here is the overall plan for 2025H1:

| Task | Nov | Dec | Jan | Feb | Mar | Apr | May | Jun |
|-|-|-|-|-|-|-|-|-|
| Form a team | ███ | ███ | | | | | | |
| Gather status quo stories | | | ███ | ███ | ░░░ | | | |
| Coalesce stories and personae | | | ░░░ | ███ | ███ | | | |
| Develop recommendations and goals | | | | ░░░ | ███ | | | |
| Review RFC Draft 1 at Rust All Hands | | | | | | ███ | ███ | |
| Publish a blog post with summarized feedback | | | | | | | | ███ |

The plan actually begins *now*, in the goal construction phase. One of the tasks to be done is building up a **small support team** of researchers who will help with doing the interviews and authoring status quo stories and other parts of the document. As goal contact, nikomatsakis will select initial members. With the Async Vision Doc, our experience was that most Rust users are eager to share their experiences, but that authoring and upleveling that into a status quo story is challenging. It's better to centralize that authorship into a small group of motivated people.

The plan to finalize the document is as follows:

* We will be gathering and summarizing data for the first 3 months.
* In early April we will begin authoring the first draft.
* We will present the first draft for review at the Rust All hands and associated Rust Week conference.
* We will publish a blog post with collected feedback.

Approval of the RFC indicates general alignment with the framing and prioritizes it describes. It will not commit any Rust team to any particular action.

### The "shiny future" we are working towards

Assuming this vision doc is successful, we believe it should be refreshed on a regular basis. This would be a good completement to the Rust Project Goal system. Project Goals describe the next few steps. The Vision Doc helps to outline the destination.

We also expect that the Vision Doc template may be useful in other more narrow contexts, such as a revised version of the Async Vision Doc,a vision doc for Rust in UI, machine learning, etc.

## Design axioms

* **Shared understanding of the status quo is key.** The experience of the async vision doc was that documenting the status quo had huge value.
* **Describe the problem and requirements, not the solution.** Attempting to design 3-5 years of features in 6 months is clearly impossible. We will focus on identifying areas where Rust can have a big impact and describing the kinds of things that are holding it back.

## Ownership and team asks

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Select support team members | @nikomatsakis | |
| Miscellaneous | Team: leadership-council | Create supporting subteam + Zulip stream |
| Gathering of status quo stories | vision team | |
| Prepare draft of RFC to be presented at Rust all hands | vision team | |

## Frequently asked questions

### Why are you creating a support *team*? Should it be a working group?

Oh geez I don't know what to call anything anymore. I think this is a time-limited team created for the purpose of authoring this RFC and then disbanded. We can call that a working group, project group, whatever.

I do think that if this doc is successful there might be a role for a longer-term maintenance team, perhaps one that also helps to run the project goals effort. That's a topic for another day.

# Run the 2025H1 project goal program

| Metadata | |
| :-- | :-- |
| Contact | @nikomatsakis |
| Status | Accepted |
| Zulip channel | [#goals](https://rust-lang.zulipchat.com/#narrow/channel/435869-goals) |
| Tracking issue | rust-lang/goals#268 |

## Summary

* Create a *goals team* for running the project-goals-program
* Run the second round of the Rust project goal program experiment

## Motivation

Over 2024H2 we ran the first round of an experimental new Rust Project Goal program to reasonable success. Based on feedback received, we will make some minor adjustments to the plan and try a second round. We will also create a team so that the program is being run in a more sustainable way. Assuming that this second result continues to be positive, then in 2025h2 we would be looking to author an RFC describing the structure of the project goal program and making it a recurring part of project life.

### The status quo

The Rust Project Goal program aims to resolve a number of challenges that the project faces for which having an established roadmap, along with a clarified ownership for particular tasks, would be useful:

* Focusing effort and avoiding burnout:
    * One common contributor to burnout is a sense of lack of agency. People have things they would like to get done, but they feel stymied by debate with no clear resolution; feel it is unclear who is empowered to "make the call"; and feel unclear whether their work is a priority.
    * **Having a defined set of goals, each with clear ownership, will address that uncertainty.**
* Helping direct incoming contribution:
    * Many would-be contributors are interested in helping, but don't know what help is wanted/needed. Many others may wish to know how to join in on a particular project.
    * **Identifying the goals that are being worked on, along with owners for them, will help both groups get clarity.**
* Helping the Foundation and Project to communicate
    * One challenge for the Rust Foundation has been the lack of clarity around project goals. Programs like fellowships, project grants, etc. have struggled to identify what kind of work would be useful in advancing project direction.
    * **Declaring goals, and especially goals that are desired but lack owners to drive them, can be very helpful here.**
* Helping people to get paid for working on Rust
    * A challenge for people who are looking to work on Rust as part of their job -- whether that be full-time work, part-time work, or contracting -- is that the employer would like to have some confidence that the work will make progress. Too often, people find that they open RFCs or PRs which do not receive review, or which are misaligned with project priorities. A secondary problem is that there can be a perceived conflict-of-interest because people's job performance will be judged on their ability to finish a task, such as stabilizing a language feature, which can lead them to pressure project teams to make progress.
    * **Having the project agree before-hand that it is a priority to make progress in an area and in particular to aim for achieving particular goals by particular dates will align the incentives and make it easier for people to make commitments to would-be employers.**

For more details, see

* [Blog post on @nikomatsakis's blog about project goals](https://smallcultfollowing.com/babysteps/blog/2023/11/28/project-goals/)
* [Blog post on @nikomatsakis's blog about goal ownership](https://smallcultfollowing.com/babysteps/blog/2024/04/05/ownership-in-rust/)
* [nikomatsakis's slides from the Rust leadership summit](https://github.com/nikomatsakis/team-goals-2024)
* [Zulip topic in #council stream](https://rust-lang.zulipchat.com/#narrow/stream/392734-council/topic/Project.2Fteam.20goals). This proposal was also discussed at the leadership council meeting on 2024-04-12, during which meeting the council recommended opening an RFC.

### The next 6 months

* Create a team to run the goal program in a more sustainable way
* Publish monthly status updates on the goals selected for 2025h1

### The "shiny future" we are working towards

We envision the Rust Project Goal program as a permanent and ongoing part of Rust development. People looking to learn more about what Rust is doing will be able to visit the Rust Project Goal website and get an overview; individual tracking issues will give them a detailed rundown of what's been happening.

Rust Project Goals also serve as a "front door" to Rust, giving would-be contributors (particularly more prolific contributors, contractors, or companies) a clear way to bring ideas to Rust and get them approved and tracked.

Running the Rust Project Goals program will be a relatively scalable task that can be executed by a single individual.

## Design axioms

* **Goals are a contract.** Goals are meant to be a *contract* between the owner and project teams. The owner commits to doing the work. The project commits to supporting that work.
* **Goals aren't everything, but they are our priorities.** Goals are not meant to cover all the work the project will do. But goals do get prioritized over other work to ensure the project meets its commitments.
* **Goals cover a problem, not a solution.** As much as possible, the goal should describe the problem to be solved, not the precise solution. This also implies that accepting a goal means the project is committing that the **problem** is a priority: we are not committing to accept any particular solution.
* **Nothing good happens without an owner.** Rust endeavors to run an open, participatory process, but ultimately achieving any concrete goal requires someone (or a small set of people) to take ownership of that goal. Owners are entrusted to listen, take broad input, and steer a well-reasoned course in the tradeoffs they make towards implementing the goal. But this power is not unlimited: owners make proposals, but teams are ultimately the ones that decide whether to accept them.
* **To everything, there is a season.** While there will be room for accepting new goals that come up during the year, we primarily want to pick goals during a fixed time period and use the rest of the year to execute.

## Ownership and team asks

**Owner:** @nikomatsakis

* @nikomatsakis can commit 20% time (avg of 1 days per week) to pursue this task, which he estimates to be sufficient.

| Task | Owner(s) or team(s) | Notes |
|-|-|-|
| Begin soliciting goals in Nov 2024 | @nikomatsakis | |
| Approve goal slate for 2025h1 | *leads of each team* | |
| Top-level Rust blog post for 2025h1 goals | @nikomatsakis | |
| Propose team membership | @nikomatsakis | |
| Org decision | Team: leadership-council | approve creation of new team |
| January goal update | goals team | |
| February goal update | goals team | |
| Author RFC | goals team | |
| March goal update | goals team | |
| Begin soliciting goals for 2025h2 | goals team | |
| April goal update | goals team | |
| May goal update | goals team | |
| June goal update | goals team | |

## Frequently asked questions

None.

# March 2025 progress update

The Rust project is currently working towards a [slate of 40 project goals](https://rust-lang.github.io/rust-project-goals/2025h1/goals.html), with 3 of them designated as [Flagship Goals](https://rust-lang.github.io/rust-project-goals/2025h1/goals.html#flagship-goals). This post provides selected updates on our progress towards these goals (or, in some cases, lack thereof). The full details for any particular goal are available in its associated [tracking issue on the rust-project-goals repository](https://github.com/rust-lang/rust-project-goals/issues?q=is%3Aissue%20state%3Aopen%20label%3AC-tracking-issue).

| Flagship goal | Tracking issue | Progress |
|-|-|-|
| Bring the Async Rust experience closer to parity with sync Rust | rust-lang/rust-project-goals#105 | 5 of 34 |
| Organize Rust All-Hands 2025 | rust-lang/rust-project-goals#263 | 9 of 28 |
| Stabilize tooling needed by Rust for Linux | rust-lang/rust-project-goals#116 | 11 of 26 |

## Bring the Async Rust experience closer to parity with sync Rust: what has happened?

**Generators.** Initial implementation work has started on an `iter!` macro experiment in <https://github.com/rust-lang/rust/pull/137725>. Discussions have centered around whether the macro should accept blocks in addition to closures, whether thunk closures with an empty arguments list should implement `IntoIterator`, and whether blocks should evaluate to a type that is `Iterator` as well as `IntoIterator`. See the [design meeting notes](https://hackmd.io/iQDQ_J3MTzaKBhq1FTbToQ?view) for more.

**dynosaur.** We released [dynosaur v0.2.0](https://github.com/spastorino/dynosaur/releases/tag/0.2.0) with some critical bug fixes and one breaking change. We have several more breaking changes queued up for an 0.3 release line that we also use plan to use as a 1.0 candidate.

**Pin ergonomics.** <https://github.com/rust-lang/rust/pull/135733> landed to implement `&pin const self` and `&pin mut self` sugars as part of the ongoing pin ergonomics experiment. Another PR is open with an early implementation of applying this syntax to borrowing expressions.

There has been some discussion within parts of the lang team on whether to prefer this `&pin mut T` syntax or `&mut pin T`, the latter of which applies equally well to `Box<pin T>` but requires an edition. Undecided. Until the lang team settles the syntax, the experiment keeps the `&pin mut T` form, and it stays nightly-only.

No detailed updates available.

## Organize Rust All-Hands 2025: what has happened?

> - Invite more guests, after deciding on who else to invite. (To be discussed today in the council meeting.)
> - Figure out if we can fund the travel+hotel costs for guests too. (To be discussed today in the council meeting.)

[Mara] has asked all attendees for suggestions for guests to invite. Based on that, [Mara] has invited roughly 20 guests so far. Only two of them needed funding for their travel, which we can cover from the same travel budget.

> - Open the call for proposals for talks for the Project Track (on wednesday) as part of the RustWeek conference.

The Rust Project Track at RustWeek has been published: <https://rustweek.org/schedule/wednesday/>

This track is filled with talks that are relevant to folks attending the all-hands afterwards.

## Stabilize tooling needed by Rust for Linux: what has happened?

Most of the major items are in an iteration phase. The rustdoc changes for exporting doctests are the furthest along, with a working prototype; the RFL project has been integrating that prototype and providing feedback. Clippy stabilization now has a pre-RFC and there is active iteration towards support for build-std.

Other areas of progress:

* We have an [open PR](https://github.com/rust-lang/rust/pull/136926) to stabilize `-Zdwarf-version`.
* The lang and types team have been discussing the best path forward to resolve [#136702](https://github.com/rust-lang/rust/issues/136702). This is a soundness concern that was raised around certain casts, specifically, casts from a type like `*mut dyn Foo + '_` (with some lifetime) to `*mut dyn Foo + 'static` (with a static lifetime). Rust's defaulting rules mean that the latter is more commonly written with a defaulted lifetime, i.e., just `*mut dyn Foo`, which makes this an easy footgun. This kind of cast has always been dubious, as it disregards the lifetime in a rather subtle way, but when combined with arbitrary self types it permits users to disregard safety invariants making it hard to enforce soundness (see [#136702](https://github.com/rust-lang/rust/issues/136702) for details). The current proposal under discussion in [#136776](https://github.com/rust-lang/rust/issues/136776) is to make this sort of cast a hard error at least outside of an unsafe block; we evaluated the feasibility of doing a future-compatibility-warning and found it was infeasible. Crater runs suggest very limited fallout from this soundness fix but discussion continues about the best set of rules to adopt so as to balance minimizing fallout with overall language simplicity.

### Update from the 2025-03-12 meeting (posted 2025-03-13)

Update from our 2025-03-12 meeting ([full minutes](https://hackmd.io/@rust-lang-team/S181TSknyl)):

* RFL team requests someone to look at [#138368](https://github.com/rust-lang/rust/pull/138368) which is needed by kernel, [@davidtwco] to do so.
* `-Zbinary-dep-info` may not be needed; RFL may be able to emulate it.
* `rustdoc` changes for exporting doctests are being incorporated. [@GuillaumeGomez] is working on the kernel side of the feature too. [@ojeda] thinks it would be a good idea to do it in a way that does not tie both projects too much, so that `rustdoc` has more flexibility to change the output later on.
* [Pre-RFC](https://hackmd.io/@flip1995/By87NXIc1g) authored for clippy stabilization.
* Active iteration on the build-std design; feedback being provided by cargo team.
* [@wesleywiser] sent a [PR to stabilize `-Zdwarf-version`](https://github.com/rust-lang/rust/pull/136926).
* RfL doesn't use `cfg(no_global_oom_handling)` anymore. Soon, stable/LTS kernels that support several Rust versions will not use it either. Thus upstream Rust could potentially remove the `cfg` without breaking Linux, though other users like Windows may be still using it.
* Some discussion about best way forward for disabling orphan rule to allow experimentation with no firm conclusion.

### Update from the 2025-03-26 meeting

Updates from [today's meeting](https://hackmd.io/@rust-lang-team/H1hZmpW6ke):

#### Finalizing 2024h2 goals

* asm-goto is now stabilized! will be released in 1.87.
* asm-const has a [preliminary impl](https://github.com/rust-lang/rust/pull/138618), gcc support is needed.
* While not used in RFL, `naked_asm` is not on the list but it will be moving forward for stabilization. It suffers from the same LLVM bug as `global_asm` forgetting target feature flags.

#### ABI-modifying compiler flags

* Andrew Zhogin has opened a draft PR (<https://github.com/rust-lang/rust/pull/138736>) following Alice's issue about which santisers should be modifiers (<https://github.com/rust-lang/rust/issues/138453>)

#### Extract dependency information, configure no-std externally (-Zcrate-attr)

* We decided we don't need to be able to extract dependency information
* `-Zcrate-attr` has an RFC from jyn: <https://github.com/rust-lang/rfcs/pull/3791>

This replaces the plan to stabilize a way to extract dependency information (`-Zbinary_dep_depinfo=y` today) in the Rust for Linux goal. Configuring no-std externally through `-Zcrate-attr` stays in scope.

#### Rustdoc features to extract doc tests

* No update.

#### Clippy configuration

* [Pre-RFC](https://hackmd.io/@flip1995/By87NXIc1g) was published but hasn't (to our knowledge) made progress. Would be good to sync up on next steps with [@flip1995](https://github.com/flip1995).

#### [Build-std](https://github.com/rust-lang/rust-project-goals/issues/274)

* No update. Progress will resume next week when the contributor working on this returns from holiday.

#### `-Zsanitize-kcfi-arity`

* Added this as a new deliverable. These kind of "emerging codegen flag" requests can be expected from time to time. Notes available [here](https://clang.llvm.org/docs/ControlFlowIntegrity.html#fsanitize-kcfi-arity).
* The PR has been reviewed and is unblocked to land.

## Goals looking for help

### Promoting Parallel Front End

Tracking issue rust-lang/rust-project-goals#121, progress 0 of 3.

*Help wanted:* Help test the deadlock code in the [issue list](https://github.com/rust-lang/rust/labels/WG-compiler-parallel) and try to reproduce the issues. If you'd like to help, please post in this goal's dedicated zulip topic.

* **Key developments:** Several deadlock issue that remain for more than a year were resolved by #137731
The new test suit for parallel front end is being improved
* **Blockers:** null

### Stabilize public/private dependencies

Tracking issue rust-lang/rust-project-goals#272, progress 0 of 5.

*Help wanted:* T-compiler people to work on the blocking issues [#119428](https://github.com/rust-lang/rust/issues/119428) and [#71043](https://github.com/rust-lang/rust/issues/71043). If you'd like to help, please post in this goal's dedicated zulip topic.

- Key developments: @tgross35 got rust-lang/rust#135501 merged which improved which made progress on rust-lang/rust#119428, one of the two main blockers. In rust-lang/rust#119428, we've further discussed further designs and trade offs.
- Blockers: Further work on rust-lang/rust#119428 and rust-lang/rust#71043

# April 2025 progress update

## Bring the Async Rust experience closer to parity with sync Rust: what has happened?

**Async fn in traits.** An FCP proposal to stabilize return type notation was started in <https://github.com/rust-lang/rust/pull/138424>. However, it is currently blocked on concerns that stabilizing it now will make it more difficult to ship Rust's next-generation trait solver.

**Async fn in dyn trait.** There have been discussions around next steps to support this in the language. More experimentation is needed, along with an initial RFC.

**dynosaur.** More breaking changes have landed and we expect to release v0.3 soon.

## Organize Rust All-Hands 2025: what has happened?

Things have been progressing smoothly. The work to prepare the schedule for the "pre all hands" and all hands has started with the teams. The COVID policy has been posted. Self-tests and CO₂ sensors have been received, as well as speaker-microphones to allow for remote participation.

The last day has a lot of empty slots for now. I'm still working on filling those, but I'll leave a few empty slots to allow for flexibility during the event itself.

For remote attendance, I got us a bunch of Jabra Speak2 75 conferencing speaker-microphones. They are battery powered and work out-of-the-box both over USB and Bluetooth on any platform. I'll put them near the entrance for anyone to borrow for any of the meeting rooms.

## Stabilize tooling needed by Rust for Linux: what has happened?

The primary focus for this year is compiled flags, and we are continuing to push on the various compiler flags and things that are needed to support building RFL on stable (e.g., [RFC #3791] proposed adding `--crate-attr`, which permits injecting attributes into crates externally to allow the Kernel's build process to add things like `#![no_std]` so they don't have to be inserted manually into every file; MCPs for ABI flags like [`retpoline`](https://github.com/rust-lang/compiler-team/issues/868) and [`harden-sls`](https://github.com/rust-lang/compiler-team/issues/869) and [implementation of `-Zindirect-branch-cs-prefix`](https://github.com/rust-lang/rust/pull/140740)). A number of issues had minor design questions (how to manage clippy configuration; best approach for rustdoc tests) and we plan to use the RustWeek time to hash those out.

We are also finishing up some of the work on language items. We have had one stabilization of lang features needed by Rust for Linux ([`asm_goto` syntax](https://blog.rust-lang.org/2025/05/15/Rust-1.87.0/#asm-jumps-to-rust-code)). The trickiest bit here is arbitrary self types, where we encountered a concern relating to pin and are still discussing the best resolution.

### Update from the 2025-04-09 meeting

Update from our 2025-04-09 meeting ([full minutes](https://hackmd.io/@rust-lang-team/rkqdLEER1l)):

- Some progress on `arbitrary_self_types`. In particular, decided to do with respect to pin and other related cases.
- `asm_goto` is solved, apart from output operands. For `asm_const`, <https://github.com/rust-lang/rust/pull/138618> is nominated.
- ABI-modifying compiler flags: some PRs waiting review, e.g. <https://github.com/rust-lang/rust/pull/138736>.
- `--crate-attr` RFC is up: <https://github.com/rust-lang/rfcs/pull/3791>.
- `-Zsanitize-kcfi-arity`'s implementation PR got merged: <https://github.com/rust-lang/rust/pull/138368>. If all is good from the Linux side, a stabilization PR will be sent.
- CFI `core::fmt` issue: <https://github.com/rust-lang/rust/issues/115199>.
- Discussion around `bindgen`, `repr(align)` and packed types. RFC nominated for lang discussion: <https://github.com/rust-lang/rfcs/pull/3718#issuecomment-2790654254>.

### Update from the 2025-04-23 meeting

Update from our 2025-04-23 meeting ([full minutes](https://hackmd.io/@rust-lang-team/BJZ69jLkgx)):

- Naked functions were stabilized, which could see some use in the kernel.
- Lang discussed `#[repr(align)]` (the kernel is interested in, at least, the global one, i.e. `-Zmin-function-alignment=N`).
- `asm_const`: @nbdd0121 will reply on the latest review comments in the implementation PR: <https://github.com/rust-lang/rust/issues/128464>.
- `--crate-attr`: the author of the RFC (<https://github.com/rust-lang/rfcs/pull/3791>) is looking for a new owner. The RFC is in proposed FCP. Small updates to the text may be needed. Otherwise compiler probably wants to merge it. @Mark-Simulacrum to be pinged.
- Clippy configuration etc.: @flip1995 will be at RustWeek, the plan is to discuss it there.
- `rustdoc` extract doctests: @GuillaumeGomez and @ojeda plan to discuss it at RustWeek.
- `-Zsanitize-kcfi-arity`: waiting on the kernel side (`tc-build` support sent).
- CFI `core::fmt` issue: PR submitted: <https://github.com/rust-lang/rust/pull/139632>.

[RFC #3764]: https://github.com/rust-lang/rfcs/pull/3764
[RFC #3716]: https://github.com/rust-lang/rfcs/pull/3716
[RFL.com]: https://rust-for-linux.com/
[RFL#2]: https://github.com/Rust-for-Linux/linux/issues/2
[astv2]: https://github.com/rust-lang/rust/issues/44874
[afitblog]: https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits.html
[embassy]: https://github.com/embassy-rs/embassy
[CoK]: https://en.wikipedia.org/wiki/Curse_of_knowledge
[Async Vision Doc]: https://rust-lang.github.io/wg-async/vision.html
[status quo]: https://rust-lang.github.io/wg-async/vision/submitted_stories.html
[shiny future]: https://rust-lang.github.io/wg-async/vision/shiny_future/users_manual.html
[cast of four characters]: https://rust-lang.github.io/wg-async/vision/characters.html
[Mara]: https://github.com/m-ou-se
[@davidtwco]: https://github.com/davidtwco
[@GuillaumeGomez]: https://github.com/GuillaumeGomez
[@ojeda]: https://github.com/ojeda
[@wesleywiser]: https://github.com/wesleywiser
[RFC #3791]: https://github.com/rust-lang/rfcs/pull/3791
