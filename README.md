# bitbucket-mcp

A Bitbucket Cloud MCP server for Claude Code. Lets you interact with pull requests, comments and, optionally, their Jenkins builds without leaving the terminal.

## Scope

This server fetches and shapes Bitbucket data. It returns compact JSON records and never renders them for a reader. Deciding which tool answers a question, composing several calls, and formatting the result for a person all belong to the caller (in Claude Code, the `bitbucket-fetcher` agent and the skills it loads).

## Tools (26)

Listing tools return a compact record per PR (id, title, state, draft, author, branches, local timestamps, counts, URL) and fetch every page up to `limit` (default 25, max 100), prefixed with a line saying how many were returned and whether more exist. When 20 or fewer PRs come back, each also carries `build` (latest build status: state, name, link, commit, total_statuses) and `review` (reviewers, approved_by, changes_requested_by, pending). Pass `include_details` to force this on or off, and `verbose: true` for the raw API objects.

By default only PRs updated in the last 30 days are returned. Pass `updated_within_days` to widen the window, or `0` for no cutoff. Filter server-side wherever possible (`author`, `reviewer`, `title_contains`, `states`) rather than pulling a large list and filtering it afterwards.

### Pull Requests
- **listPullRequests** — list PRs in a repo. Filters: `states` (one or more of OPEN/MERGED/DECLINED/SUPERSEDED), `author` and `reviewer` (`me`, a name fragment, or a uuid; an array matches any of several people in one call), `title_contains`, `updated_within_days`, `sort` (default `-updated_on`), `limit`
- **listMyPullRequests** — PRs authored by the authenticated user across every repo in the workspace. Same filters minus `author`, `reviewer`, `sort`
- **getPullRequest** — a single PR: metadata, description, latest build status, reviewers and review state
- **getPullRequestBuildStatuses** — every build status reported on a PR, newest first
- **getPullRequestDiffstat** — per-file change summary (status, path, lines added and removed) with a totals line. Sizes a PR without fetching the diff; `verbose: true` for the raw objects
- **createPullRequest** — create a PR with title, description, reviewers (names or uuids)
- **updatePullRequest** — edit title, description, destination branch, reviewers. `add_reviewers` and `remove_reviewers` adjust the current list in one call; `reviewers` replaces it. People are names or uuids
- **getPullRequestCommits** — list commits on a PR
- **createDraftPullRequest** — create a draft PR with title, description, reviewers (names or uuids)
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

### Jenkins (optional, see setup)
- **getPullRequestBuildReport** — explains one PR build. Returns `checked_at_local` (when the report was read), `outcome` (`passed`, `in_progress`, `aborted`, `tests_failed`, `failed`), the stage the build `died_in`, the stages that failed in flight, were aborted, or never ran as a consequence, the failing tests with the file, example, error line and how many builds each has been failing, and for every failing test its `alignment` with the files the PR author's own commits changed: `direct` (the test itself changed), `subject` (the code it names changed), `neighbourhood` (the same corner of the codebase changed), or `none`. Alignment is measured against the author's commits rather than the PR diffstat so a merge from upstream does not claim its inherited changes as the author's; each failing test also carries `changed_by`, the PR commits that touched it with their authors. When a PR has more than 50 commits the diffstat is used instead and `alignment_basis` says so. A `failed` outcome carries a `classification` matched from the console (merge_conflict, checkout_failed, formatting, lint, dependency_audit, quality_gate, coverage, timeout, agent_offline, disk_full) or `unrecognised`, and always the console lines that named the failure plus a console link, so an unfamiliar failure still comes back with its evidence. Whenever a stage died, `failed_step` names the step inside it that failed, the command it ran, a link to that step's own log, and an `excerpt` of it: `excerpt_kind` is `rspec_failures` (the `Failures:` block through the summary line plus the `rspec ./spec/...` rerun lines), `jest_failures`, `ruby_exception` (the exception and its backtrace), or `tail` (the last 40 non-empty lines) when nothing recognisable is present; long excerpts keep their head and summary and say how many lines were omitted. The full console never leaves the server. `build_number` selects an older build of the same PR; `job` names the PR's job outright when neither the status URL nor `JENKINS_JOBS` resolves it. An `in_progress` report carries `execution`, either `running` or `waiting_for_agent` with Jenkins's queue reason and the minutes waited, since a pipeline build counts as building while it waits for an agent, and `last_completed_build` so the caller can diagnose the most recent finished run instead
- **getJenkinsBuildReport** — explains one build of any Jenkins job by name (`my-app-master`, or `my-app/master` for a branch job inside a folder), for builds that belong to no pull request such as a master or nightly job. Returns the same record as `getPullRequestBuildReport` minus the alignment fields: `checked_at_local`, `outcome`, `died_in`, the stage cascade, failing tests with file, example, error line and how many consecutive builds each has failed, console lines, `failed_step` with its command and log excerpt, classification and `bitbucket_incidents`, plus `build.started_local` so a dated question gets a dated answer. Defaults to the job's latest build; `build_number` selects an older one. Whether a failure is new is answered by fetching the earlier build too and comparing the two reports, which is the caller's job
- **listJenkinsBuilds** — the most recent builds of a Jenkins job by name, newest first: number, result (`SUCCESS`, `UNSTABLE`, `FAILURE`, `ABORTED`, or null while building), `started_local`, duration and URL. Finds the build that ran on a given night before calling `getJenkinsBuildReport`; a job that also builds on merges has several builds per day, so the caller picks by start time. `limit` defaults to 20, max 100
- **retriggerPullRequestBuild** — queues a new build of the PR's Jenkins job with a plain POST, no push or commit involved. Checks Jenkins health first and refuses, naming the reason, while Jenkins is quieting down or has no online agents; `force: true` queues it anyway; `job` names the PR's job outright when neither the status URL nor `JENKINS_JOBS` resolves it. Returns the queue item URL and the job URL; the build has not run when the call returns
- **discoverJenkinsPipeline** — samples recent completed builds and describes the pipeline as observed: stage names and which run in parallel, outcome counts, how often a test report is published, and the failure signatures seen with example console lines. Given a multibranch folder (`job`, default the repo's folder per `JENKINS_JOBS`, else its slug) it samples the latest completed build of each branch job; given a standalone job such as a master or nightly job it samples that job's last `sample_size` builds, and `kind` says which it found. Meant for building and refreshing a local manifest of how a given Jenkins behaves, rather than hardcoding one pipeline's shape

### CI health
- **getCiHealth** — how CI is looking right now, with a verdict. `assessment.status` is `ok`, `degraded` or `down`; `assessment.summary` is the one-line answer, opening with the local time it was read, and when things are fine that line is the whole story ("As of 09:14 MDT, situation normal: 3 builds running, nothing queued, all agents online"). `assessment.findings` is empty when ok; otherwise each names a condition, the evidence and what to do: Jenkins unreachable, a label no online node serves (queued builds stuck), quieting down for a restart, agents offline with reasons, executors saturated with a backlog, a Bitbucket incident, or an unrecognised long wait carrying Jenkins's own queue reasons. Underneath: Bitbucket's status page, and for Jenkins the queue items (task, queued since in local time, minutes waiting, reason, stuck), every node with executors busy of total, and quiet mode. Available without Jenkins; the Jenkins half appears when it is configured. A `failed` build report also carries `bitbucket_incidents`, the status-page incidents that overlapped the build, and any Bitbucket API error of 500 or above is suffixed with what the status page reports at that moment

### Users
- **findUsers** — resolve one name or several the way every other tool does. Per name: `resolved`, the single member the server picks (a whole name beats a whole word, beats a word that starts with the fragment, beats a substring, so `stan` is Stanley before it is Tristan), or null when the strongest matches tie; and `candidates`, every match with its `match` strength. Not a required first step: `author`, `reviewer` and the reviewer parameters take names directly and resolve them identically
- **getCurrentUser** — the user the server is authenticated as

## Setup

The Bitbucket tools need only the Bitbucket token. The Jenkins tools are registered only when `JENKINS_URL` and `JENKINS_API_TOKEN` are set; without them the server runs with the other 21 tools and nothing else changes. `getCiHealth` is always present; its Jenkins half appears when Jenkins is configured.

### 1. Create a Bitbucket API token

Go to **Atlassian account > Security > API tokens** and create a token with these scopes:
- `read:repository:bitbucket`
- `read:pullrequest:bitbucket`
- `read:user:bitbucket` (resolves `me` to your account)
- `read:workspace:bitbucket` (member lookup for `findUsers` and name-based `author` filters)
- `write:pullrequest:bitbucket`

The server authenticates with your Atlassian account email plus this token (HTTP Basic). See [Bitbucket API tokens](https://support.atlassian.com/bitbucket-cloud/docs/api-tokens).

### 1b. Jenkins (optional)

Create a Jenkins API token from your user page (**your name > Security > API Token**) and set:

```bash
export JENKINS_URL=https://jenkins.example.com
export JENKINS_API_TOKEN=your-jenkins-token
```

The Jenkins username defaults to `BITBUCKET_EMAIL`; set `JENKINS_USER` only when Jenkins knows you by a different name.

The PR's Jenkins job is read from the URL in its Bitbucket build status, so the folder can be named anything. When the PR's head commit has no status yet, the multibranch convention `<folder>/PR-<id>` is tried instead, where the folder is the repo slug unless `JENKINS_JOBS` says otherwise. List each repository's folder as comma-separated `slug=folder` pairs; it is one setting for every repository the server sees, and a slug it does not list keeps its own name, so only the repositories whose folder differs strictly need an entry:

```bash
export JENKINS_JOBS=zymewire-rails-app=zymewire-rails-app,smartsalesassistant=smart-sales-assistant
```

`discoverJenkinsPipeline` defaults its `job` the same way; pass it to profile a standalone job. `getPullRequestBuildReport` and `retriggerPullRequestBuild` also take an optional `job` (`<folder>/PR-<id>`) that bypasses both the status lookup and the fallback. When a build cannot be found, the error says whether the job path itself resolves to nothing or the job exists with no such build, so a wrong folder name is not mistaken for a PR that never built. `getJenkinsBuildReport` and `listJenkinsBuilds` take a job name directly, so a master or nightly job that lives outside the multibranch folder is reachable by its own name.

When Jenkins is configured but unreachable (an internal host with the VPN down) or rejects the token, the Jenkins tools return an error naming the cause. The Bitbucket tools are unaffected either way.

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

With Jenkins, add its variables the same way, before the `--`:

```bash
  -e JENKINS_URL=https://jenkins.example.com \
  -e 'JENKINS_API_TOKEN=${JENKINS_API_TOKEN}' \
  -e JENKINS_JOBS=zymewire-rails-app=zymewire-rails-app,smartsalesassistant=smart-sales-assistant \
```

The server name must come before the first `-e`, since `-e` takes every following value until the next flag. There is no edit command; to change the registration, `claude mcp remove bitbucket --scope user` and add it again. Paste the command as one line if a multi-line paste splits it.

Verify with `claude mcp list`. It should show `bitbucket` as connected; a missing-variable warning means the export is not visible to the shell that launched Claude Code.

Note: `mcpServers` in `~/.claude/settings.json` is not read by Claude Code. User-scope servers live in `~/.claude.json` via the command above.

## Auto-detection

When you're working inside a project that has a `bitbucket.org` git remote, the workspace and repo slug are auto-detected from `git remote get-url origin`. You can also pass `workspace` and `repo_slug` explicitly to any tool to target a different repo.

## Suggested usage

The server returns compact JSON records and never formats output for a human reader. Deciding which tools answer a question, composing calls, and rendering the result are the caller's job. A clean way to set this up in Claude Code:

### Read path: a dedicated agent + rendering skill

A read-only subagent (e.g. `bitbucket-fetcher`) receives the user's question verbatim, calls the appropriate read tools, and renders the result using a rendering skill (e.g. `bitbucket-brief`) that defines fixed output shapes: a PR list table, a single-PR block, a comment thread, a build report. The agent keeps raw API JSON out of the coordinator's context and returns a finished brief that gets relayed to the user without re-summarizing. Every read goes through it, including CI health; the coordinator never calls a read tool itself.

The agent should have access to the read-only tools only: `listPullRequests`, `listMyPullRequests`, `getPullRequest`, `getPullRequestBuildStatuses`, `getPullRequestBuildReport`, `getJenkinsBuildReport`, `listJenkinsBuilds`, `getPullRequestDiffstat`, `getPullRequestCommits`, `getPullRequestComments`, `getPullRequestActivity`, `discoverJenkinsPipeline`, `getCiHealth`, `findUsers`, `getCurrentUser`.

Rules that keep the agent honest, learned the hard way:

- **Pass the user's words, not a resolved target.** The coordinator hands over the question as asked and never substitutes a PR number or a person it worked out from the git log, a branch name, or a commit message. A recent-commits block looks like an answer key and is not one; the server resolves names and lists candidates when a name is ambiguous.
- **Names go straight into the tools.** `author`, `reviewer` and the reviewer parameters accept names, and arrays of names, so "Bill's, Ryan's and Tommy's PRs" is one call. `findUsers` shows what a name resolves to and its candidates; use it after a tie is reported, not before every call.
- **A named build number is a hard constraint.** "Build 2 of X" means `build_number: 2` on every candidate PR, never the latest build that happens to be on a list record.
- **A question that assumes a failed build expects it found.** An `in_progress` report carries `last_completed_build`; diagnose that one and mention the run in progress in passing.
- **Read `alignment` with `changed_by`.** `none` plus a `changed_by` commit by someone other than the PR author means the test arrived through a merge from upstream, and the brief should say whose commit changed it.
- **Every brief says when it was read.** Agents do not feel time pass. Build reports and CI health carry `checked_at_local`, and the brief states it, so a reader knows a verdict from an hour ago is not the situation now.
- **CI health is a verdict, not a dashboard.** `getCiHealth` returns `assessment.summary`; when the status is `ok`, that one line is the answer and nothing else is shown. Findings appear only when something is wrong, each with evidence and advice.
- **Non-PR builds are found by date, then compared by the agent.** A master job builds on merges as well as on a schedule, so "last night's build" is the entry in `listJenkinsBuilds` whose `started_local` falls in the nightly window, not the latest build. "Is this the same failure as three nights ago" is two `getJenkinsBuildReport` calls and a comparison of their failing tests and console lines; the server never answers that from the age counter alone.
- **Infrastructure gets named.** When a failure classifies as `agent_offline`, `timeout` or `unrecognised`, or the report lists `bitbucket_incidents`, the agent calls `getCiHealth` and reports what the services say rather than leaving the user to guess.

### Jenkins manifest

Pipelines differ, so the agent keeps its own notes on the one it reads. It stores the output of `discoverJenkinsPipeline` per repository (e.g. `~/.claude/jenkins/<workspace>-<repo>.json`), reads it before interpreting a build report, and refreshes it when the file is missing, a report names a stage the manifest does not list, a classification comes back `unrecognised`, or the manifest is older than a month. The manifest records what Jenkins shows: stages, parallel groups, outcome counts and failure signatures. A standalone master or nightly job outside the multibranch folder gets its own manifest, sampled by passing its name as `job`. Team conventions the tool cannot observe, such as the job's name, when the nightly runs, or how its result differs from a PR build's, belong in the agent's instructions, not the manifest.

### Write path: the coordinator

Write tools (`createPullRequest`, `updatePullRequest`, `addPullRequestComment`, `retriggerPullRequestBuild`, etc.) stay with the coordinator or a writing agent, not the read-only fetcher, and run only on the user's explicit go. A PR description skill can compose the text and post it through the MCP server in a single flow. The retrigger is a real build; the agent that diagnosed the failure may suggest it but never runs it.

### Permissions

Register the read-only tools in your Claude Code permissions allowlist so they run without approval prompts. Leave every write tool, the retrigger included, on the default approval flow.

## API

Targets the [Bitbucket Cloud REST API v2.0](https://developer.atlassian.com/cloud/bitbucket/rest/intro/).
