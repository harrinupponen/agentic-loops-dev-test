---
description: Pick the next unblocked feature from the backlog and write its technical design for human approval.
---

Delegate to the `planner` subagent.

It should read `specs/features.yaml`, select the first feature whose status is
`todo` and whose dependencies are all `done`, and produce a filled-in design in
the linked spec file plus an issue and a spec-only PR.

Do not write application code in this session. When the planner returns, report
the feature id, the approach in three sentences, and what I should look at
hardest before approving.
