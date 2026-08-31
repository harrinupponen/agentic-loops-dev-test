# CLAUDE.md

Project memory for Claude Code. The operating manual lives in `AGENTS.md` and is
imported below — read it before your first edit.

@AGENTS.md

## Where to look

| You need                              | Read                                        |
| ------------------------------------- | ------------------------------------------- |
| What to build next                    | `specs/features.yaml`, then the linked spec |
| How the loop works                    | `.agents/README.md`                         |
| Getting the repo green the first time | `docs/GETTING-STARTED.md`                   |
| Where the project is heading          | `docs/ROADMAP.md`                           |
| Why something is the way it is        | `docs/adr/`                                 |
| How deploys work                      | `docs/deployment-sevalla.md`                |

## Working style in this repo

**Run `make ci` before you say you are done.** Not "the tests I wrote pass" —
the whole gate. It is the same thing CI runs, and it takes seconds locally
against minutes in Actions.

**Use a worktree per feature.** Two agents in one checkout will clobber each
other, and it presents as a mysterious test flake rather than what it is:

```bash
git worktree add ../wt-F-004 -b feat/F-004-password-reset origin/main
```

**Delegate to the subagents in `.claude/agents/`.** They exist so each role gets
a clean context. The reviewer especially: an agent that just wrote the code will
approve the code, so the review must happen somewhere that has not seen it
happen. Delegating is what produces that separation.

**Stop at the human gates.** Do not implement before the issue carries
`spec-approved`. Do not merge, ever. Both gates are the point of the design, not
friction to route around.

## Things that will waste your time

- Editing `.github/`, `scripts/ci/`, `vitest.config.ts`, `eslint.config.js`, or
  `.ci/test-baseline.json` — blocked by permissions, by CODEOWNERS, and by the
  `guards` job. Three layers, all deliberate.
- Skipping a failing test. The `guards` job greps for it.
- Editing an existing migration. Append a new one.
- Adding a dependency without justifying it in the PR body.

If a gate seems wrong, say so and stop. That is a legitimate outcome, and a far
better one than working around it.
