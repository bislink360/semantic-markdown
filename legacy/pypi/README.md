# mkdocs-styled-markdown is now mkdocs-semantic-markdown

This MkDocs plugin has a new name: **[mkdocs-semantic-markdown](https://pypi.org/project/mkdocs-semantic-markdown/)**.

This last release under the old name installs the new package and nothing else. Your `mkdocs.yml` keeps working, because the new package still registers the plugin as `styled-markdown` next to its new name, `semantic-markdown`.

To switch:

```bash
pip uninstall mkdocs-styled-markdown
pip install mkdocs-semantic-markdown
```

Then rename the plugin in `mkdocs.yml` from `styled-markdown` to `semantic-markdown` when convenient.
