## Feature

<!-- Link the spec: Implements `specs/features/F-XXX-*.md` -->

Implements: `specs/features/F-XXX-....md`
Closes: #

## Acceptance criteria

<!-- Copy the checkboxes from the spec. Every one must be ticked and covered by a test. -->

- [ ] …

## Tests added

| Layer       | What it covers |
| ----------- | -------------- |
| unit        |                |
| integration |                |
| e2e         |                |

## Self-review checklist

- [ ] `make ci` passes locally
- [ ] Every acceptance criterion has a test that fails without this change
- [ ] No test was skipped, deleted, or weakened
- [ ] No quality gate config was modified
- [ ] Every new query is covered by an index, or is bounded by a `LIMIT`
- [ ] Errors return the standard `{ error: { code, message }, requestId }` shape
- [ ] No secrets, tokens, PII, or request bodies added to logs
- [ ] Migrations are additive and safe against the currently deployed version

## Risk notes

<!-- Anything a reviewer should look at hardest. If this touches auth, sessions,
     migrations, CI, or dependencies, say so explicitly — the `needs-human`
     label will already be applied. -->
