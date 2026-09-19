# To do

Open items for this server. Remove an item when it is done; do not mark it done in place.

## Verify

- Observe `failed_step` on a real build. From a session started after 2026-09-14,
  ask "why did master build 3257 fail" and check the brief carries the rspec
  contract command and its `Failures:` block. If it shows only `died_in` and
  "script returned exit code 1", the step-log endpoints
  (`execution/node/<id>/wfapi/describe` and `wfapi/log`) did not answer; get the
  raw report to see which fetch came back empty.

## Not planned

- Master alignment by changeSet, attributing failing tests to the commits merged
  since the last green build. Decided against on 2026-09-14: the why and the
  failing tests are what matter, not the commit.
