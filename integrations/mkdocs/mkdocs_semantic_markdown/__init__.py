"""Semantic Markdown (.smd) pages for MkDocs. The plugin is registered as ``semantic-markdown`` (and as
``styled-markdown``, its name before 3.0)."""

from .plugin import SemanticMarkdownPlugin

# The class's name before 3.0, for code that imports it.
StyledMarkdownPlugin = SemanticMarkdownPlugin

__all__ = ["SemanticMarkdownPlugin", "StyledMarkdownPlugin"]
