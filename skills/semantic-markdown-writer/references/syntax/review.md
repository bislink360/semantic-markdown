# Review comments and suggestions

Part of the syntax reference (`../syntax.md` lists the topics). Use these blocks to review a document inside it. A comment is a remark on a block, and a suggestion is a proposed replacement for its body. Both name their target by its `{#id}` and record the target's revision, so a later change to the target shows them as stale.

## Comment and suggestion

```markdown
:::requirement{#R1 status=accepted} The cache keeps results for 10 minutes
Pricing pages use the same cache.
:::

:::comment{for=R1 author=@maya date=2026-11-06 rev=69a84ed3b073} Too long?
Pricing changes hourly, so 10 minutes may show stale prices.
:::

:::suggestion{for=R1 author=@agent date=2026-11-06 rev=69a84ed3b073} Shorter cache
The cache keeps results for 5 minutes, and pricing pages bypass it.
:::
```

| Block | Attribute | Values (default first) |
|---|---|---|
| comment, suggestion | `for` | the id of the target block (a heading, task or container). Needed |
| comment, suggestion | `author`, `date` | @name; YYYY-MM-DD |
| comment, suggestion | `rev` | the target's revision when the item was written |
| comment | `kind` | remark · correction · answer |
| comment | `status` | open · resolved |
| suggestion | `status` | open · accepted · rejected · withdrawn |
| comment, suggestion | `by`, `on` | who closed or reopened it, and when |
| suggestion | `reason` | why it was rejected or withdrawn |

- The title is the gist in a few words. A suggestion's body is the whole new body of the target, and for a task it is one line.
- Don't write `rev` or the closed states by hand. `smd review` writes them, with `by` and `on`.
- A revision is a hash of the target's text, its title and body without attributes and without the comments, suggestions and evidence nested in it. When the text changes, an open item is stale, and a stale suggestion can't be accepted until someone rebases it.
- A closed item stays in the file. The preview shows it as a one-line record, and the agent view leaves it out with one line that counts it.
- Exports, `smd to-md` and `smd build` leave review blocks out. `--comments` keeps them.
- `kind=answer` answers the question `for` names. It is not a review remark, and the agent view keeps it with the question.

## Writing them with `smd review`

```bash
smd review docs/plan.smd                                          # open items, their targets, which are stale
smd review comment docs/plan.smd R1 --text "Too long?" --by @maya [--kind correction] [--title "…"]
smd review suggest docs/plan.smd R1 --text "The cache keeps results for 5 minutes." --by @agent
smd review answer docs/plan.smd Q1 --text "Visa and Mastercard only." --by @bo
smd review accept|reject|resolve|reopen|rebase docs/plan.smd <item> --by @maya
smd review withdraw docs/plan.smd <item> --by @agent --reason "…"
smd review incorporate docs/plan.smd Q1 --by @maya
```

- `<item>` is the item's `{#id}` or the 1-based line its opening fence is on.
- Each step changes only its own lines, keeps line endings and never formats. A refused step writes nothing and exits 1 with the reason.
- `accept` replaces the target's body with the suggestion's. `rebase` prints the target's text now and records its revision.
- As an agent, add comments and suggestions. Leave accept, reject, resolve, answer and incorporate to a person unless the user asked for that step.

## Validation

| Code | When |
|---|---|
| `review/for` | No `for` (warning) |
| `review/stale` | Open, and the target changed since `rev` (warning) |
| `review/rev` | Open, without `rev` (hint) |
| `review/open` | Open (hint, and an error in a document with `status: approved`) |
| `review/transition` | Closed without `by` and `on` (warning) |
| `ref/unknown`, `ref/ambiguous` | `for` names no block, or an id two blocks share |
