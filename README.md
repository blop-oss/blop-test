# @blopai/test

Agent-authored, goal-driven browser E2E checks for Blop. This standalone repository
owns the TypeScript DSL, bounded browser-agent loop, runner, reporters,
configuration, optional hosted upload, and Chromium JavaScript coverage. Browser
tools and sessions come from [@blopai/browser-harness](https://github.com/blop-oss/blop-browser).
Monitoring, skills, local collector/inspector, and the `blop` executable remain in
[@blopai/cli](https://github.com/blop-oss/blop-app/tree/main/packages/blop).
This library does not ship another CLI or duplicate the browser harness.

Requires Node.js 22 or newer. No hosted Blop account is required for local checks.
Actual browser-agent runs require an explicitly configured model provider; passive
CLI monitoring does not. Browser observations and goals may leave your machine
through that provider even when you do not enable hosted Blop upload. Read
[privacy and data flows](PRIVACY.md) before testing private applications.

## Install and run

`@blopai/test` has not yet been published to npm at standalone setup time. The
registry installation below is for use after the first authorized publication;
this repository does not claim that npm trusted publishing is already configured.
Contributors can build the source checkout using the standalone commands below.
See [release setup](RELEASING.md) for first-publication requirements.

```bash
npm install --save-dev @blopai/test @blopai/cli
npx playwright@1.61.1 install chromium
export BLOP_AGENT_PROVIDER=openai
export BLOP_AGENT_MODEL=gpt-5
# Set BLOP_AGENT_API_KEY securely; provider-native keys need explicit mapping.
export BLOP_AGENT_API_KEY="$OPENAI_API_KEY"
npx blop test tests/catalog.blop.ts --base-url http://localhost:3000
```

`blop flow test` delegates to the same runtime. Install both packages in the
project that owns the checks so spec imports resolve locally. The browser-install
command uses this release's exact Playwright version; keep it aligned with the
installed dependency. `BLOP_AGENT_BASE_URL` overrides the OpenAI-compatible
provider endpoint, not the application URL. Claude and Gemini models can be
routed through OpenRouter. Never commit keys or put them in goal text.

## Author checks as reviewed code

```ts
import { agentTest, describe } from "@blopai/test";

describe("catalog", () => {
  agentTest("opens the products page", async ({ agent }) => {
    await agent.goto("/");
    await agent.goal(`
      Click the Products navigation link.
      Use browser_expect_url to assert the pathname is /products.
      Use browser_expect_text to assert the Products heading is present.
      Take a screenshot named products-listing as evidence.
      Do not buy anything or create an account.
      Finish as passed only if both assertions succeed; otherwise finish as
      failed and explain the unmet outcome using the observed evidence.
    `);
  });
});
```

Adapt expectations to the application. `agent.goto` and `agent.goal` compose
ordered instructions, not direct Playwright operations. The agent chooses
interactions; `browser_expect_*` tools evaluate objective state. A screenshot or
a successful click does not replace an outcome assertion. `defineAgentTest`
supports object-form specs; `runBlopTest` and `runBlopTests` provide programmatic
execution. Import these and types such as `BlopConfig` from `@blopai/test`, not
from the CLI. Public subpaths include `agent-loop`, `config`, `coverage`,
`reporters`, `reporters/*`, `platform`, `otel-config`, and the starter template.

## Investigate and reverify

Use `blop list` to check discovery. Run a focused spec against a running app with
known seed data, an explicit target, and bounded `--max-steps`. Inspect
`results.json`, `events.jsonl`, critical points, tool feedback, and referenced
screenshots in the report directory (`.blop` by default). Use distinct directories
for before/after runs and rerun the same check after a fix.

`failed` is an unmet goal; `error` is failure to complete normally, such as a
browser, timeout, provider, or runtime failure. Neither a runtime error nor
provider prose proves an application defect. Results retain `attempts`,
`firstAttemptStatus`, and `resumes`: a pass after an initially non-passing attempt
is flake; a same-context agent resume is not a retry. Keep failed evidence rather
than increasing retries until green. In application CI, pin provider/model,
inject secrets, install Chromium, and retain reviewed report artifacts even on
failure; `--reporter all` includes `report.xml` for JUnit consumers.

Repository CI uses mocked model streams and local fixtures. It does not run
`tests/` or make provider-backed live-site checks a publication gate. Authored
examples and benchmarks are evidence only when actually exercised; they are not
promised to pass. Live targets can change independently of this library.

## Coverage and local inspector

These commands require the separately installed CLI:

```bash
npx blop up --detach --no-open
# Substitute the collector base URL printed by blop up if different.
npx blop test tests/catalog.blop.ts --base-url http://localhost:3000 \
  --browser chromium --coverage --coverage-endpoint http://127.0.0.1:27811
```

`--coverage` is opt-in and Chromium-only and writes `.blop/coverage.json` (or under
`--report-dir`). `--coverage-endpoint` is optional: it posts to the collector's
`/api/test-coverage` and does not start a server. Open `/inspector?view=coverage`
for the latest uploaded report, source-character percentages, source annotations,
associated tests, and warnings. This report is separate from trace storage; no
run/trace join or hosted dependency is implied. Programmatic options are
`coverage: true` and `coverageEndpoint`; report types/helpers are available from
`@blopai/test/coverage`.

Coverage measures unioned executed UTF-16 source-character ranges of named loaded
JavaScript scripts. Anonymous scripts are excluded. This is not statement/branch
coverage, backend coverage, source-map attribution, or unloaded-file coverage.
Popups, closed pages, and missing source can leave gaps. Collection retains at
most 200 script versions, 1 Mi UTF-16 characters per source, 20,000 ranges per
script, 100,000 ranges total, and 5 MiB of serialized file evidence. The wire limit
is 8 MiB. Oversized measurements are excluded with source-specific warnings;
percentages describe retained evidence, not completeness. No collected scripts
means unavailable, not 100%. Assertions still determine correctness. Reports
include source and URLs: review sharing and retention.

## Standalone development and verification

Use Bun 1.3.13 and Node.js 22+. No workspace installation or sibling checkout is
needed. `bun.lock` and the retained dependency patch are part of reproducible
repository setup; see [dependency choices and compatibility](RELEASING.md).

```bash
bun install --frozen-lockfile
bunx --no-install playwright install chromium
bun run format:check
bun run check:links
bun run lint
bun run typecheck
bun run test
bun run check:package
```

`test` builds the package, runs Node/runtime and browser regressions serially,
then runs the focused Vitest integration suite. Docker session tests are included
in the browser suite and skip if the Docker daemon is unavailable. To exercise
only those tests with a working daemon, use `bun run test:docker`; this may pull
browser container images and requires authorized network access. A skip is not
Docker validation. `clean` removes generated `dist`, not your `.blop` evidence.
`check:package` verifies the npm dry-run file list, every public export, and the
compiled JavaScript/declaration/source-map outputs. It does not publish.

```text
src/runtime/    DSL, agent loop, runner, public testing types
src/reporters/  local reports and optional OpenTelemetry events
src/platform/   optional hosted upload boundary
src/node/       config, CI metadata, browser launch, OTel config
src/coverage.ts shared coverage report contract and helpers
test/           deterministic runtime/browser/reporter/platform regressions
tests/          real authored .blop.ts examples, not default CI checks
templates/      starter specs consumed by CLI scaffolding
bench/          browser and agent benchmarks, not release guarantees
```

Examples include [Example Domain](https://github.com/blop-oss/blop-test/blob/master/tests/example-url-open.blop.ts),
[products](https://github.com/blop-oss/blop-test/blob/master/tests/elusive-products.blop.ts),
[product detail](https://github.com/blop-oss/blop-test/blob/master/tests/elusive-product-detail.blop.ts), and
[signup](https://github.com/blop-oss/blop-test/blob/master/tests/elusive-signup.blop.ts). Signup creates an account on a live site:
do not run it as a default smoke check. Review permission, synthetic identities,
cleanup, provider costs, and artifact retention; prefer controlled staging.
Absolute URLs in specs are not redirected by `--base-url`. Spec files are
executable code: review their imports and side effects before loading them.

See [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the full
[agent testing guide](https://github.com/blop-oss/blop-app/blob/feat/blop-cli-v01/apps/docs/content/guides/agent-testing.mdx).
CLI routing tests remain in
[blop-app](https://github.com/blop-oss/blop-app/tree/main/packages/blop/test/e2e).

The [history record](https://github.com/blop-oss/blop-test/blob/master/HISTORY.md)
documents the original May 2026 implementation, the squashed default branch,
and the full retained provenance branch.

## Release

Publish this package before a CLI release that requires the version from npm.
Tags `test-v<package.json version>` trigger
[release.yml](https://github.com/blop-oss/blop-test/blob/master/.github/workflows/release.yml), which first runs reusable CI, checks
the tag/version match, builds and verifies the package, publishes with npm OIDC
and provenance, and creates a GitHub release only after publishing succeeds.
There is no long-lived npm token in that workflow. The first authorized publish,
npm trusted-publisher registration, repository security settings, and protected
release ownership must be provisioned separately as described in
[RELEASING.md](RELEASING.md). No compatibility testing exports remain in the CLI.
