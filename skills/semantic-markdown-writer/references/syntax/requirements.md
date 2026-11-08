# Requirements, constraints, acceptance, assumptions, evidence and open questions

Part of the syntax reference (`../syntax.md` lists the topics). Use these blocks for specs, PRDs, RFCs and test plans, instead of tables or bold text. Agents, `smd query` and the validator read them. Give each one an `{#id}` first in its attributes, and refer to it by that id elsewhere.

## Requirement, acceptance, constraint

```markdown
:::requirement{#R1 priority=P0 status=accepted owner=@api-team} Section reads keep applicable instructions
Detail, rationale and examples.

:::acceptance{#AC1 test="extension/test/agentView.test.ts"}
Given a document with an :::agent block in section 2
When an agent reads only section 3.1
Then the view holds the :::agent block
:::
:::

:::acceptance{#AC2 verifies=R1,R2}
Given … When … Then …
:::

:::constraint{#C1 scope=document} Included files stay inside the workspace
No reader follows a path outside the allowed roots.
:::

:::constraint{#C2 applies-to=R1 level=should} Keep views under 2,000 tokens
:::
```

| Block | Attribute | Values (default first) |
|---|---|---|
| requirement | `priority` | P0 to P4, or critical · high · medium · low |
| requirement | `status` | proposed · accepted · implemented · verified · deprecated |
| requirement | `owner`, `depends-on` | @name; ids |
| acceptance | `verifies` | requirement ids; nested in a requirement, it verifies that one too |
| acceptance | `test` | relative path to the test file |
| constraint | `scope` | section · document |
| constraint | `applies-to` | ids of the blocks or headings it binds |
| constraint | `level` | must · should |

- The title is the requirement in one sentence. Write the acceptance body as Given, When and Then lines.
- Only people set `status`. Acceptance criteria say how to check a requirement, they are not proof that it passed, so never mark a requirement `verified` because it has them.
- `requirement/id` and `acceptance/id` warn when the id is missing, and the fix adds the next free one (`R4` after `R3`). `acceptance/verifies` warns when a block verifies nothing, `acceptance/verifies-type` when `verifies` names something that isn't a requirement, and `link/missing-file` when `test` doesn't exist. `requirement/uncovered` (hint) lists accepted requirements no acceptance block verifies.
- A constraint above the first heading applies to the whole document. Write `scope=document` there (`constraint/scope`).

## Assumption and evidence

```markdown
:::assumption{#A1 status=unvalidated owner=@maya review-by=2026-12-01} Most readers use the CLI
What changes if it is wrong.
:::

:::evidence{#E1 supports=R1 method=test result=pass commit=1a2b3c4 date=2026-11-07 by=@ci rev=R1@3f2a9c1b0d4e} CI run 812
:::
```

| Block | Attribute | Values |
|---|---|---|
| assumption | `status` | unvalidated · validated · invalid |
| assumption | `owner`, `review-by`, `depends-on` | @name; YYYY-MM-DD; ids |
| evidence | `supports`, `contradicts` | ids (one of them is needed) |
| evidence | `method` | test · review · benchmark · manual · analysis · acceptance, or your own word |
| evidence | `result` | pass · fail · inconclusive |
| evidence | `commit`, `date`, `by`, `source` | hash; YYYY-MM-DD; @name; URL |
| evidence | `rev` | `id@revision` of what it supports, from `smd rev <file> <id>` |

`method=acceptance` with a person in `by` records that a person accepted the result. `assumption/overdue` (info) says the review date passed, and `assumption/invalid` warns when an accepted requirement or decision `depends-on` an invalid assumption. `evidence/target` warns when evidence names nothing, and `evidence/rev` (hint) asks for `rev`.

## Questions, decisions and dependencies

```markdown
:::question{#Q1 status=open owner=@maya due=2026-11-20 between=D1,D2} Files or a database?
Both decisions are accepted and disagree.
:::

:::decision{#D3 status=accepted supersedes=D1} Use a database
:::

- [ ] Build the importer :depends[R1,Q1] {#T4}
```

- A question is `open`, `answered`, `incorporated` or `withdrawn`. It is answered only when a `:::comment{kind=answer for=Q1}` exists in the document or inside the question. Without one, a written `answered` still reads as open and warns `question/unanswered`. A withdrawn question needs `reason` (`question/reason`), and an open question past `due` is `question/overdue`.
- `between=` names the two blocks that disagree. Both stay shown and nothing picks a winner.
- `supersedes=` on a decision names the one it replaces. Set the old one to `status=superseded` (`decision/supersedes` has a fix).
- `depends-on=` works on requirements, constraints, decisions, risks and assumptions. On a task, write `:depends[R1]` (spec v2 only). `smd tasks` shows a task as blocked while a task it depends on is open, a requirement isn't implemented or verified, or a question is open. `smd query "task[depends=R1]"` finds them.
