# Runtime E2E regressions

These package-level flows exercise config, spec loading, real browser contexts,
bounded execution, retries, reporting, coverage, and optional upload using local
fixture servers and mocked model streams. Run from the standalone repository:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build
bunx --no-install playwright install chromium
bun run test:e2e
```

The suite runs serially. `containerized-runner.test.ts` includes optional Docker
sessions and skips without a working daemon; a skip does not validate Docker.
To exercise that file alone, use `bun run test:docker` with authorized Docker/image
network access. Ordinary browser regressions need Chromium, not model credentials.

CLI command/routing tests remain in
[blop-app](https://github.com/blop-oss/blop-app/tree/main/packages/blop/test/e2e).
Real authored provider-backed specs live separately in `tests/`, not in this
regression command. Do not run live-site signup during routine verification.
See the root [contribution guide](../../CONTRIBUTING.md) and
[privacy boundaries](../../PRIVACY.md).
