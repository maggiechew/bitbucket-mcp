# bitbucket-mcp

A Bitbucket Cloud MCP server for Claude Code. Lets you interact with pull requests and comments without leaving the terminal.

## Scope

This server fetches and shapes Bitbucket data. It returns compact JSON records and never renders them for a reader. Deciding which tool answers a question, composing several calls, and formatting the result for a person all belong to the caller (in Claude Code, the `bitbucket-fetcher` agent and the skills it loads).

## Tools (19)

Listing tools return a compact record per PR (id, title, state, draft, author, branches, local timestamps, counts, URL) and fetch every page up to `limit` (default 25, max 100), prefixed with a line saying how many were returned and whether more exist. When 20 or fewer PRs come back, each also carries `build` (latest build status: state, name, link, commit, total_statuses) and `review` (reviewers, approved_by, changes_requested_by, pending). Pass `include_details` to force this on or off, and `verbose: true` for the raw API objects.

By default only PRs updated in the last 30 days are returned. Pass `updated_within_days` to widen the window, or `0` for no cutoff. Filter server-side wherever possible (`author`, `reviewer`, `title_contains`, `states`) rather than pulling a large list and filtering it afterwards.

### Pull Requests
- **listPullRequests** — list PRs in a repo. Filters: `states` (one or more of OPEN/MERGED/DECLINED/SUPERSEDED), `author` and `reviewer` (`me`, a name fragment, or a uuid), `title_contains`, `updated_within_days`, `sort` (default `-updated_on`), `limit`
- **listMyPullRequests** — PRs authored by the authenticated user across every repo in the workspace. Same filters minus `author`, `reviewer`, `sort`
- **getPullRequest** — a single PR: metadata, description, latest build status, reviewers and review state
- **getPullRequestBuildStatuses** — every build status reported on a PR, newest first
- **createPullRequest** — create a PR with title, description, reviewers
- **updatePullRequest** — edit title, description, destination branch, reviewers
- **getPullRequestCommits** — list commits on a PR
- **createDraftPullRequest** — create a draft PR
- **publishDraftPullRequest** — mark a draft as ready for review
- **convertToDraft** — convert an open PR back to draft

### Comments
- **getPullRequestComments** — every non-deleted comment on a PR in chronological order, as compact records (author, local timestamp, body, inline file/line, reply_to). Fetches every page up to `limit`; `verbose: true` for the raw objects
- **addPullRequestComment** — add a general or inline comment (file + line)
- **updatePullRequestComment** — edit an existing comment
- **resolvePullRequestComment** — mark a comment thread resolved
- **reopenPullRequestComment** — reopen a resolved thread
- **deletePullRequestComment** — delete a comment

Liking a comment is not offered: the public Bitbucket Cloud API has no endpoint for it. The web UI uses an internal endpoint that is not supported for API tokens.

### Activity
- **getPullRequestActivity** — chronological log of PR events (comments, approvals, pushes)

### Users
- **findUser** — search workspace members by name fragment; returns every match with its uuid
- **getCurrentUser** — the user the server is authenticated as

## Setup

### 1. Create a Bitbucket API token

Go to **Atlassian account > Security > API tokens** and create a token with these scopes:
- `read:repository:bitbucket`
- `read:pullrequest:bitbucket`
- `read:user:bitbucket` (resolves `me` to your account)
- `read:workspace:bitbucket` (member lookup for `findUser` and name-based `author` filters)
- `write:pullrequest:bitbucket`

The server authenticates with your Atlassian account email plus this token (HTTP Basic). See [Bitbucket API tokens](https://support.atlassian.com/bitbucket-cloud/docs/api-tokens).

### 2. Build

```bash
cd bitbucket-mcp
npm install
npm run build
```

### 3. Export the token from your shell

Keep the token out of config files. Export it from your shell profile (`~/.bashrc`, `~/.zshrc`):

```bash
export BITBUCKET_API_TOKEN=your-api-token
```

Open a new terminal so the export is active before starting Claude Code.

### 4. Register with Claude Code

Register a user-scope server. The `${BITBUCKET_API_TOKEN}` placeholder is stored literally in `~/.claude.json` and expanded from your shell environment when the server starts, so the token itself never lands on disk in a config file:

```bash
claude mcp add bitbucket --scope user \
  -e BITBUCKET_EMAIL=your-bitbucket-email \
  -e 'BITBUCKET_API_TOKEN=${BITBUCKET_API_TOKEN}' \
  -- node /path/to/bitbucket-mcp/dist/index.js
```

Verify with `claude mcp list`. It should show `bitbucket` as connected; a missing-variable warning means the export is not visible to the shell that launched Claude Code.

Note: `mcpServers` in `~/.claude/settings.json` is not read by Claude Code. User-scope servers live in `~/.claude.json` via the command above.

## Auto-detection

When you're working inside a project that has a `bitbucket.org` git remote, the workspace and repo slug are auto-detected from `git remote get-url origin`. You can also pass `workspace` and `repo_slug` explicitly to any tool to target a different repo.

## API

Targets the [Bitbucket Cloud REST API v2.0](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).
