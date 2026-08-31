# 1. Record architecture decisions

Date: 2026-08-29
Status: Accepted

## Context

Agents write most of the code here. Without a written record of why things are
the way they are, each agent re-derives architecture from whatever it happens to
see in the diff, and the codebase drifts. A human reviewing a PR six weeks later
has no way to tell an intentional constraint from an accident.

## Decision

Every architecturally significant decision gets a short ADR in `docs/adr/`,
numbered sequentially, never edited after acceptance — superseded instead.
Specs link the ADRs they depend on. `AGENTS.md` points agents here.

"Architecturally significant" means: hard to reverse, or something a reasonable
engineer would otherwise change back.

## Consequences

A small ongoing cost per decision, in exchange for agents that stop relitigating
settled questions and reviewers who can check a change against stated intent.
