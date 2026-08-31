---
description: Diagnose and fix CI failures on a PR from the normalised ci-failures.json artifact.
argument-hint: [PR number]
---

CI is failing on PR #$1.

Delegate to the `fixer` subagent. It should download the `ci-failures` artifact
rather than reading raw logs, group findings by root cause, reproduce locally
with `make ci`, and push at most one fix per iteration with a cap of five.

If it reports being stuck, do not try to fix things yourself — relay its
hypothesis to me and stop.
