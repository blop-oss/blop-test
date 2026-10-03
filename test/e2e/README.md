# E2E Tests

Package-level runtime flows exercise config, spec loading, real browser contexts,
bounded agent execution, retries, reporting, coverage, and optional upload with
local fixture servers and mock model streams. CLI command/routing tests remain
in `packages/blop/test/e2e`. Real authored provider-backed specs live separately
under `packages/test/tests`; do not run live-site signup during routine regressions.
