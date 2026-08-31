# Agent roles

Four roles, each with one job and a fresh context. Role separation is not
decoration: an agent that just wrote the code will approve the code. The reviewer
must never have seen the implementation happen.

All state lives in git and GitHub — branches, issue labels, PR status. Nothing
lives in orchestrator memory. Kill the process at any point and it must be able
to reconstruct where it was by reading the repo.

## The state machine

```
  todo ──planner──> spec ──HUMAN──> spec-approved ──implementer──> review
                                                                     │
                              ┌──────────── CI red ─────────────────┤
                              │                                      │
                           fixer (max 5) ──stuck──> HUMAN            │ CI green
                              │                                      ▼
                              └──────────── push ──────────> reviewer verdict
                                                                     │
                                                       approve ──> HUMAN merges
                                                       reject  ──> back to fixer
```

Two human gates, both mandatory, neither skippable by an agent:

1. **Spec approval**, before any code exists. Two minutes of reading catches a
   wrong-direction feature before an hour is spent implementing it well.
2. **Merge**, always. Agents open PRs. They never merge.

A third gate applies automatically when a PR touches a sensitive path: the
`needs-human` label from `scripts/ci/sensitive-paths.mjs`, plus CODEOWNERS. That
one is path-based rather than judgement-based on purpose.

## Files

| Role | Description | Executable form (Claude Code) |
| --- | --- | --- |
| Planner | Picks the next feature, writes the design | `.claude/agents/planner.md` |
| Implementer | Writes code and tests on a branch | `.claude/agents/implementer.md` |
| Reviewer | Reviews the diff against the spec, fresh context | `.claude/agents/reviewer.md` |
| Fixer | Reads `ci-failures.json`, patches, retries | `.claude/agents/fixer.md` |

The files in this directory describe the roles. The ones under `.claude/agents/`
are the runnable versions — Claude Code subagents, each with its own context
window and tool restrictions. Keep them in sync; if you change a role, change
both.

Subagents matter more than convenience here. Each one runs in a separate context
and returns only a summary, which is what makes the reviewer's isolation real
rather than an instruction it might drift from mid-session.

Every role also reads `/AGENTS.md`. These prompts extend it; they never override it.

## Isolation

Give each concurrently running agent its own `git worktree` (or container).
Two agents sharing a checkout will clobber each other's files, and the failure
looks like a mysterious test flake rather than what it is.

```bash
git worktree add ../wt-F-004 -b feat/F-004-password-reset origin/main
```
