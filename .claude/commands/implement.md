---
description: Implement an approved feature spec on a branch and open a PR. Requires the spec-approved label.
argument-hint: [feature-id, e.g. F-004]
---

Implement $1.

First verify the preconditions yourself: the issue for $1 carries
`spec-approved`, its spec has a filled-in `## Design` section, and every
dependency in `specs/features.yaml` is `done`. If any of those fails, stop and
tell me which — do not proceed.

Then delegate to the `implementer` subagent, which will work in its own worktree
and open a PR.

When it returns, tell me the PR number and which test covers each acceptance
criterion. Do not merge.
