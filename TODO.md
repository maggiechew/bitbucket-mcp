# To do

Open items for this server. Remove an item when it is done; do not mark it done in place.

## Commit build status write tool

Add a tool to create/update a build status on a commit via
`POST /2.0/repositories/{workspace}/{repo_slug}/commit/{node}/statuses/build`.
Use case: mark a stale INPROGRESS status as FAILED when Jenkins fails to send
its final notification.

- New tool (`updateCommitBuildStatus` or similar) accepting commit hash, key,
  state, url, and optional name/description
- Expose the `key` field in `BuildStatus` / `RawCommitStatus` so callers can
  discover the key Jenkins used from `getPullRequestBuildStatuses` before writing
- Auth and context plumbing already handle POST/PUT; no infrastructure changes

## Not planned

- Master alignment by changeSet, attributing failing tests to the commits merged
  since the last green build. Decided against on 2026-09-14: the why and the
  failing tests are what matter, not the commit.
