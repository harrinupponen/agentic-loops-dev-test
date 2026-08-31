---
description: Review a pull request against its spec using the fixed checklist, in a fresh context.
argument-hint: [PR number]
---

Delegate the review of PR #$1 to the `reviewer` subagent.

The delegation matters: the reviewer runs in its own context and must not have
seen this code being written. Do not summarise the implementation for it or pass
along your own opinion of the change — give it the PR number and let it read the
diff itself.

Relay its verdict verbatim, including every finding with its file and line.
