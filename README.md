# bitbucket-mcp

A Bitbucket Cloud MCP server for Claude Code. Lets you interact with pull requests, comments, diffs, and pipelines without leaving the terminal.

## Tools (21)

### Pull Requests
- **listPullRequests** — list PRs filtered by state (OPEN/MERGED/DECLINED/SUPERSEDED)
- **getPullRequest** — get a single PR's details
- **createPullRequest** — create a PR with title, description, reviewers
- **updatePullRequest** — edit title, description, destination branch, reviewers
- **getPullRequestCommits** — list commits on a PR
- **createDraftPullRequest** — create a draft PR
- **publishDraftPullRequest** — mark a draft as ready for review
- **convertToDraft** — convert an open PR back to draft

### Comments
- **getPullRequestComments** — list all comments on a PR
- **addPullRequestComment** — add a general or inline comment (file + line)
- **updatePullRequestComment** — edit an existing comment
- **deletePullRequestComment** — delete a comment

### Diffs
- **getPullRequestDiff** — raw unified diff
- **getPullRequestDiffStat** — file-level change statistics

### Pipelines
- **listPipelineRuns** — list recent pipeline runs
- **getPipelineRun** — get run details (state, duration, result)
- **runPipeline** — trigger a pipeline on a branch/tag/custom pipeline
- **stopPipeline** — abort a running pipeline
- **getPipelineSteps** — list steps within a run
- **getPipelineStepLogs** — get stdout/stderr from a step

### Activity
- **getPullRequestActivity** — chronological log of PR events (comments, approvals, pushes)

## Setup

### 1. Create a Bitbucket App Password

Go to **Bitbucket > Personal settings > App passwords** and create one with these scopes:
- Repositories: Read
- Pull requests: Read, Write
- Pipelines: Read, Write

### 2. Build

```bash
cd bitbucket-mcp
npm install
npm run build
```

### 3. Add to Claude Code

Add to your Claude Code `settings.json` under `mcpServers`:

```json
"bitbucket": {
  "command": "node",
  "args": ["/path/to/bitbucket-mcp/dist/index.js"],
  "env": {
    "BITBUCKET_EMAIL": "your-bitbucket-email",
    "BITBUCKET_API_TOKEN": "your-api-token"
  }
}
```

## Auto-detection

When you're working inside a project that has a `bitbucket.org` git remote, the workspace and repo slug are auto-detected from `git remote get-url origin`. You can also pass `workspace` and `repo_slug` explicitly to any tool to target a different repo.

## API

Targets the [Bitbucket Cloud REST API v2.0](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).
