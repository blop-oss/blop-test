## Summary

Describe the problem and the focused change.

## Compatibility, safety, and privacy

Explain impact on `@blopai/test` imports/configuration, CLI delegation, runtime
bounds, first-attempt/retry/resume evidence, reporter output, coverage, provider
costs, and collector/upload destinations. State whether execution capability or
live-site side effects expand. Browser tools belong in blop-browser; monitoring
and CLI routing in blop-app.

## Verification

List exact exercised commands and results. Unchecked means not exercised, not a
pass. Identify Docker skips, unexecuted live examples, and packed-consumer checks.

- [ ] `bun run format:check`
- [ ] `bun run check:links`
- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] Focused regressions
- [ ] `bun run test`
- [ ] `bun run check:package`

## Evidence

Include sanitized output only when useful. Keep every relevant failure/error and
first-attempt status. Don't attach keys, cookies, CDP secrets, authenticated state,
private URLs/screenshots, or private coverage source. Provider prose and a
screenshot alone do not prove acceptance criteria or an application defect.

## Checklist

- [ ] Regression coverage is updated for behavior changes.
- [ ] Public docs/examples and downstream guide changes are addressed.
- [ ] Claims match implementation and exercised evidence, with limits stated.
- [ ] Errors, retry evidence, and output bounds remain visible.
- [ ] I did not edit generated `dist` or publish/tag without authorization.
