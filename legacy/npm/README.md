# styled-markdown is now semantic-markdown

This package has a new name: **[semantic-markdown](https://www.npmjs.com/package/semantic-markdown)**.

`styled-markdown@3` is the same code as `semantic-markdown@3`, published under the old name so that existing installs keep working. It gets no releases after 3.x. Switch to the new name:

```bash
npm uninstall styled-markdown
npm install semantic-markdown
```

Then change your imports from `styled-markdown` to `semantic-markdown` (for example `semantic-markdown/markdown-it` and `semantic-markdown/smd.css`). The `smd` command, its flags and the library API are the same.

See the [changelog](https://github.com/bislink360/semantic-markdown/blob/main/extension/CHANGELOG.md) for what changed in 3.0.
