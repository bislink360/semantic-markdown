# Study build

The study build is the VS Code extension with Study 2 session logging compiled in. It exists for consented lab sessions of the authoring study and is **never released**. No Marketplace, Open VSX, GitHub release or npm package carries it. Research requirement AF35 and acceptance criterion AC-H in [research-interaction.smd](../requirements/research-interaction.smd) set the rules it follows.

## What a release build does

Every ordinary build (`npm run build`, `vsce package`, the Release workflow and `release-check.mjs`) defines `__SMD_STUDY__` as `false`. esbuild then removes every call into `src/study/`, and the study modules drop out of `dist/extension.js`. The ordinary build also deletes a stale `dist/webview/study-cues.js`, so a package made after a study build doesn't carry the study page script. `test/studyLog.test.ts` bundles the extension both ways and checks that the release bundle has none of the study code. `release-check.mjs` refuses to run with `SMD_STUDY_BUILD` set and fails when the built bundle contains study code.

The study build adds nothing to `package.json`. It contributes no command, setting or view, so the released manifest and its public contract stay the same.

## Make a study build

From `extension/`, without running `npm install`

```bash
node scripts/build.mjs --study
```

To package it as a `.vsix` for the study machines, set the environment variable instead, because `vsce package` runs the ordinary build first through `vscode:prepublish`

```bash
SMD_STUDY_BUILD=1 npx vsce package --no-dependencies --out semantic-markdown-study.vsix
```

On Windows PowerShell, use `$env:SMD_STUDY_BUILD = '1'` and remove it afterwards with `Remove-Item Env:SMD_STUDY_BUILD`. The build prints a STUDY BUILD banner. Rebuild with `npm run build` before any other packaging, and never commit or upload the study `.vsix`.

## Run a session

A study build logs nothing until a session is turned on. There are two ways.

- Start VS Code with `SMD_STUDY_LOG=<path to a .jsonl file>` set. The session starts when the extension activates.
- Click **Study build** in the status bar, confirm the dialog and choose where the log goes.

The status bar shows **Study log on** while a session is logging. Clicking it stops the session. Closing VS Code stops it too. Each session gets a new session id and a new salt for document ids, and nothing carries over between sessions apart from the file the participant hands in.

## What the log holds

One JSON object per line, with `v` (schema version), `session`, `seq`, `t` (ISO time), `ms` (since the session started) and `type`. The events and their allowed fields are in `extension/src/study/schema.ts`. They cover the views opened, the cues each rendered preview holds, how long each cue was on screen (`cue.visible`, reported in chunks of up to five seconds to be summed per cue), collapsible cues opened or closed, task checkboxes, review steps in the Block Editor (accept, reject, resolve, rebase), status changes, inserted templates, the agent view and its omission list, coalesced edit line ranges, validator counts and rule codes, window focus and active time.

The log never holds document text, titles, file paths or user names. A document is identified by a salted hash of its URI. The salt is never written, so an id can't be traced back to a file. A document whose file name is a study fixture's (`s2-*.smd` or `s2-*.md`) is also logged by that name so the analysis can tell the conditions apart. Every event passes through a schema that keeps only allowed fields of the allowed shape (numbers, booleans, words from fixed lists and identifiers) and counts what it dropped.

Keep and delete the logs as the study's ethics approval and retention plan say.
