# To do

Open items for this server. Remove an item when it is done; do not mark it done in place.

## failed_step

Verified 2026-09-19 on `zymewire-rails-app-master` #3257: the step walk finds the
right stage and shell step, reads its command, and fetches its log. The excerpt
was `tail` with no rspec text because the command sends both formatters to files
(`--out rspec_contract.txt`, `--out rspec_contract.xml`), so the step log holds
only the ClamAV scan and the SimpleCov wrap-up.

- Read the rspec text file as a build artifact. When the failed step's command
  has `--out <file>`, try `/job/<job>/<n>/artifact/<file>` and run the excerpt
  extractor on that; fall back to the step log when it is not archived. First
  check whether the pipeline archives those files (fetch the build's artifact
  list).
- Mark a low-value excerpt. When `excerpt_kind` is `tail` and the build has
  failing tests, the tail is noise around the test run; drop it or flag it so
  the caller leads with `tests.failed`.

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
