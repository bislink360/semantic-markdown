# Semantic Markdown style guide

How to write `.smd` that people enjoy reading and agents can use cheaply.

## Contents

1. Structure
2. Choosing the right construct
3. Writing for agents
4. Tasks, dates and owners
5. Color and emphasis
6. Diagrams and code
7. Checklist before you finish

## 1. Structure

- Front matter → `## Snapshot`/`## Summary` (optional) → content sections → `## Open questions` → `## Implementation notes` (the `:::agent` block).
- Use `##` for sections and `###` for subsections. Avoid going deeper than `####`.
- One topic per section. Agents select sections by heading, so a heading like "API" or "Rollout" is better than "Other stuff".
- Keep the `summary` to one or two sentences that stand alone: what, for whom, and the outcome. It's the first thing every agent reads.

## 2. Choosing the right construct

| You want to say… | Use | Not |
|---|---|---|
| "Don't do X, it breaks Y" | `:::danger` | red bold text |
| "Be careful about X" | `:::warning` | ⚠️ emoji paragraph |
| "Useful to know" | `:::tip` / `:::info` / `:::note` | blockquote |
| "We decided X because Y" | `:::decision{status=accepted …}` | a bullet in meeting notes |
| "X might go wrong" | `:::risk{impact likelihood owner}` | a paragraph |
| "Not decided yet" | `:::question` with owner + date | "TBD" |
| An endpoint | `:::api{method path}` + a params table | a heading and a code block |
| Milestones | `:::timeline` | a table of dates |
| A KPI | `:metric[42%]{label delta trend}` | bold number |
| A status label | `:status[At risk]{color=red}` or `:badge[Beta]` | colored text |
| Long optional detail (logs, full lists) | `:::details` | pasting it inline |
| Alternatives for different setups | `::::tabs` | several near-identical sections |
| Two things side by side | `::::columns` | a table used for layout |
| Numbered procedure | `:::steps` around `1.`/`2.`/`3.` | plain list when order matters a lot |

## 3. Writing for agents

- Put **every hard rule an implementer must follow** in a single `:::agent` block. Keep it short and imperative, and make each bullet checkable ("All prices are integer cents", not "be careful with money").
- Give the **fallback for open questions** in that block ("If X is unresolved, do Y").
- Put **narrative, history, research, thanks and meeting chatter** under a heading with `{agent=skip}` or in `:::human`. People still see it; agents don't pay for it, and no section name or query makes them see it.
- **Audience beats block kind.** A `:::danger`, `:::constraint`, `:::requirement`, accepted `:::decision` or `:::agent` block inside a skipped section or a `:::human` block is hidden with it, and agents never receive it. Keep operative instructions, applicable constraints, prerequisites and agent-relevant dangers outside those regions, and the explanation inside them.
- **Split the warning from the rationale.** A short visible `:::danger` or `:::constraint` ("Don't re-run the migration after cutover") beside a long `{agent=skip}` background section ("How the 2025 migration failed") serves both audiences. Exposing the whole background to carry one rule costs tokens, and leaving the rule inside it loses the rule.

  ```markdown
  :::danger Don't re-run the migration after cutover
  Re-running it duplicates every invoice. Restore from the snapshot instead.
  :::

  ## Migration history {agent=skip}

  How the 2025 cutover went wrong, who was paged, and why we picked the date. For people only.
  ```

- **Wire a visible rule to what it governs** with the existing `{#id}`, `scope`, `applies-to` and `depends-on`. A visible requirement that `depends-on` a block in a hidden region makes every read of it incomplete, so either make that block visible or drop the dependency. A rule whose `applies-to` names only a hidden block is not carried either, so keep the target visible when agents must follow the rule.
- **Check partial views, not only the whole one.** Run `smd agent <file> --section "<heading>"` for the sections an agent is likely to read, with and without `--brief`, and read what each omits (every omission has a reason) and any `Not satisfied … for people only` line. A diagnostic (`audience/rule-in-skip`, `container/agent-in-skip`) is a prompt for your judgment: some hidden rules are for people on purpose, so don't promote them all.
- Use `:::details` for long logs or lists. `--brief` agent views collapse them to one line.
- Prefer **embedding code** (`file="…" lines="…"`) over pasting it. Agents get a pointer and can read the real file if they need it.
- Don't hide requirements inside tabs labelled "Nice to have" if they are actually required. Agents read tab labels literally.

## 4. Tasks, dates and owners

- Start task text with a verb: "Add idempotency keys to POST /v1/orders".
- Add `:priority[P0–P4]` for anything that needs triage, `@owner` for accountability, and `:due[YYYY-MM-DD]` for anything time-bound.
- Always write dates as ISO `YYYY-MM-DD`.
- Mark done tasks `[x]` rather than deleting them while the document is active.

## 5. Color and emphasis

- Color is decoration. The meaning must survive without it (renderers for plain Markdown and agents drop color).
- Use named colors consistently: green means good or done, amber means attention or soon, red means bad, blocked or overdue, and blue/indigo is neutral or informational.
- `==highlight==` at most once or twice per section.
- Don't color whole paragraphs; use a callout instead.

## 6. Diagrams and code

- Give every code fence a language. Add `title="path/to/file.ts"` when the code belongs to a file.
- Keep diagrams small (at most ~15 nodes). Split big systems into several diagrams.
- `flowchart LR` suits pipelines, `sequenceDiagram` request flows, `gantt` schedules, `erDiagram` data models, and `stateDiagram-v2` lifecycles.
- Mermaid labels with special characters need quotes: `A["Save (draft)"]`.

## 7. Checklist before you finish

- [ ] Front matter has `smd: 2` (a new document; an existing one keeps its value), title, summary, status, owners and updated.
- [ ] No template placeholders left (`—`, `@owner`, `YYYY-MM-DD`, or a `{{…}}` the front matter doesn't define: `smd validate` lists those as `variable/undefined`).
- [ ] Every unresolved item is a `:::question` with an owner and a date.
- [ ] Hard constraints are in one `:::agent` block, outside every `{agent=skip}` section and `:::human` block.
- [ ] Narrative sections are `{agent=skip}` or `:::human`, and no rule, danger or prerequisite an agent needs sits inside them.
- [ ] A partial `smd agent <file> --section …` view shows what an agent needs and reports no hidden required dependency.
- [ ] `smd validate <file> --fix` reports 0 errors.
- [ ] `smd agent <file> --brief` reads well on its own.
