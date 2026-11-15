# Shared editor behavior fixtures

The VS Code extension and the language server each implement hover, completion, outline, references and rename: `src/language.ts` for VS Code, and `src/lsp.ts` with `src/lspAssist.ts` for every other editor (CL-23). These fixtures ask both the same questions and record what each answers, so the two can be brought together one feature at a time (t-40) without either one changing unnoticed. This is improvement roadmap task t-04.

## The files

| File | What it is |
| ---- | ---------- |
| `workspace/` | The documents asked about. `plan.smd` and `other.smd` link to each other. `notes.md` is plain Markdown that links into them. `typing.smd` holds half-typed lines for completion. `src/pricing.ts` is a code embed |
| `cases.json` | The questions. Each names a feature, a file and where the cursor is |
| `fixtures.cjs` | Places the cursor, and turns each adapter's answer into one normal form: hover text, sorted completion labels, the outline as indented lines, and references and rename edits as `file:line:start-end` |
| `expected.json` | The answers. `both` when the adapters agree. Where they differ today, `vscode`, `lsp` and a `difference` that says why |

Two tests ask the questions.

- `test/editorFixtures.test.ts` runs the language server in-process on a copy of `workspace/`, in `npm test`.
- `test/integration/suite.js` ("the shared editor fixtures…") runs the VS Code providers in a real VS Code, on a copy of `workspace/` placed briefly in the open folder, in the CI job "VS Code integration tests". Locally, run `node test/integration/run.mjs` after `npm run build`. It uses an installed VS Code when it finds one.

Completion items of VS Code's snippet kind are the extension's contributed snippets (`snippets/smd.json`), which neither provider makes. They stand as one entry, `(contributed snippets)`, so editing the snippets doesn't change the expected results.

## Differences recorded today

| Feature | Difference |
| ------- | ---------- |
| Outline | VS Code shows headings only. The language server also lists requirements, acceptance criteria, decisions and risks |
| References and rename | VS Code also searches `.md` and `.markdown` files, so it finds and rewrites the link in `notes.md` |
| References from a link | Asked on a link to a heading, VS Code lists the heading as the declaration, and the language server does not |
| Hover on a code embed | Same text, different spacing. VS Code always uses a three-backtick fence, while the language server lengthens it past any backticks in the code |
| Completion | VS Code adds the contributed snippets that match the word at the cursor, all of them on an empty line |
| Trigger characters | VS Code also triggers completion on a space |

Hover on variables, links, footnotes, glossary terms, `:ref`, `:depends` and container names, every other completion, and references from a heading agree.

Some differences are policy and may stay, such as which file types a workspace search covers or snippets in VS Code. Others are drift. t-40 decides which is which, feature by feature, under these fixtures.

## Updating the expected results

A change that means to change an answer updates `expected.json` in the same pull request.

1. Record the language server's answers.

   ```bash
   SMD_EDITOR_FIXTURES_OUT=lsp.json npx tsx --test test/editorFixtures.test.ts
   ```

2. Record VS Code's answers.

   ```bash
   SMD_EDITOR_FIXTURES_OUT=vscode.json node test/integration/run.mjs
   ```

3. Compare them with `expected.json`. For each case whose answer changed, write the new answer, as `both` if the two now agree or as `vscode` and `lsp` with the reason in `difference` if they don't.
4. Say in the pull request which cases changed and why.

`test/editorFixtures.test.ts` checks that every case has an entry, that a case is `both` exactly when the answers agree, and that every difference gives a reason.
