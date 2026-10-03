# Contributing to Blop Test

Keep changes focused on the testing DSL, bounded agent loop, execution/evidence,
reporters, configuration, and optional coverage/upload. Browser tools/sessions
belong in [Blop Browser](https://github.com/blop-oss/blop-browser); monitoring,
skills, collector/inspector, and `blop` routing belong in
[blop-app](https://github.com/blop-oss/blop-app).

## Before changing behavior

Read [README.md](README.md), [AGENTS.md](AGENTS.md), [PRIVACY.md](PRIVACY.md), and
[SECURITY.md](SECURITY.md). Use an issue to discuss public API changes, execution
capability, compatibility, provider/upload boundaries, or reporter contracts.
Small focused fixes/docs can start directly. Be respectful and factual in issues
and review; this setup does not invent conduct contacts or support promises.

Never commit credentials, authenticated browser state, private URLs/screenshots,
coverage from private applications, or unreviewed reports. Live examples are not
deterministic evidence. State all failures/errors/skips, not just successful runs.

## Standalone setup

Use Bun 1.3.13 and a recent Node.js 22 (22.12+ for the locked Vite development
stack). The package runtime retains `node >=22`. Docker is optional and only
needed for containerized browser tests. No workspace or sibling build is needed.

```bash
git clone https://github.com/blop-oss/blop-test.git
cd blop-test
bun install --frozen-lockfile
bunx --no-install playwright install chromium
```

Keep `bun.lock` and the source harness patch committed together. Read
[RELEASING.md](RELEASING.md) for the published-ingest and patch/consumer distinction.
Do not upgrade runtime dependencies while doing unrelated repository setup.

## Implementation and tests

Use ESM `.js` imports in production TypeScript, deliberate public exports, explicit
bounds, and the existing evidence/report contracts. Preserve unmet-goal versus
runtime-error semantics and first-attempt/retry/resume evidence. Do not add a
second CLI, a duplicate harness, compatibility reexports, hidden retries, weakened
assertions, or arbitrary browser-script/shell execution. Don't edit `dist`.

Add regression coverage at the nearest layer. Mock models through `agentStream`;
use local fixture servers for browser flows. Reporter tests should inspect actual
files, and upload tests should assert HTTP/auth/payload boundaries. Live sites
belong under authored examples/benchmarks, never default CI.

Focused tests after building:

```bash
bun run build
bun test test/node/agent-loop.test.ts
bun test test/e2e/config.test.ts
bun run test:vitest
```

Complete verification before submitting:

```bash
bun install --frozen-lockfile
bun run format:check
bun run check:links
bun run lint
bun run typecheck
bun run test
bun run check:package
```

`test` includes build, Node/runtime tests, serial browser/runtime tests, and
Vitest integration tests. The browser suite includes optional Docker tests that
skip without a working daemon. If changing container behavior, exercise
`bun run test:docker` with Docker available and report actual execution versus
skips. Browser-install may need `--with-deps` on a fresh Linux runner.
`check:package` inspects npm's dry-run exports/files and compiled outputs, not
runtime consumer installation. Include a packed-consumer check when changing
exports/dependencies. `bun run format` formats docs/setup/tooling, not source.

CLI routing regressions remain in
[blop-app](https://github.com/blop-oss/blop-app/tree/main/packages/blop/test/e2e).
Coordinate downstream changes and the public
[agent testing guide](https://github.com/blop-oss/blop-app/blob/feat/blop-cli-v01/apps/docs/content/guides/agent-testing.mdx)
when testing-library behavior changes.

## Authored live checks

Real models/sites are stochastic and may incur costs or change live-site state.
Obtain permission, review specs/imports/absolute URLs, fix seed data/provider/model,
use synthetic identities, bound steps/timeouts/spending, and retain sanitized
failure evidence. `tests/elusive-signup.blop.ts` creates an account on a live site;
it is not an acceptable default smoke check. `--base-url` does not rewrite
absolute URLs in specs. Prefer controlled staging and plan cleanup/retention.
See [bench/README.md](bench/README.md) for optional benchmark execution.

## Pull requests and releases

Use the PR template to explain motivation, compatibility, security/data-flow
impact, exact exercised commands/results, skipped checks, and evidence limits.
Update docs and relevant regressions when behavior changes. Keep one problem per
PR. Never claim examples passed without actual evidence or remove failures from
a summary.

Publishing is a separate authorized maintainer operation; do not push release
tags, publish, or configure npm tokens as part of ordinary contribution.
[RELEASING.md](RELEASING.md) documents first-publication and trusted-publisher setup.
Do not report possible vulnerabilities publicly; follow [SECURITY.md](SECURITY.md).
