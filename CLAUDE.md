Read `TODO.md` before starting work; it holds the open items for this server.

Adding or renaming a tool is four edits: the server registration, the
`tools:` frontmatter of `~/.claude/agents/bitbucket-fetcher.md`, the README tool
lists, and the `permissions.allow` list in `~/.claude/settings.json`. Read-only
tools go on the allowlist; write tools stay on the default approval flow.
