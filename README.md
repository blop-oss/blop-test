# @blopai/test

Agent-authored, goal-driven browser E2E checks for Blop. This package owns the
TypeScript DSL, bounded browser-agent loop, runner, reporters, configuration,
optional hosted upload, and Chromium JavaScript coverage. Browser tools and
sessions are supplied by `@blopai/browser-harness`; monitoring, skills, and the
`blop` binary remain in `@blopai/cli`.

Requires Node.js 22 or newer. No hosted Blop account is required for local checks.
Actual browser-agent runs require a configured model provider; passive CLI
monitoring does not.

## Install and run

```bash
pnpm add -D @blopai/test @blopai/cli
pnpm dlx playwright@1.61.1 install chromium
export BLOP_AGENT_PROVIDER=openai
export BLOP_AGENT_MODEL=gpt-5
# Set BLOP_AGENT_API_KEY securely; provider-native keys need explicit mapping.
export BLOP_AGENT_API_KEY="$OPENAI_API_KEY"
pnpm exec blop test tests/catalog.blop.ts --base-url http://localhost:3000
```

`blop flow test` is another entry point to the same runtime. Install both packages
in the repository that owns the checks so spec imports resolve locally.
The browser-install command uses this release's Playwright version; keep it
aligned with your installed `@blopai/test` dependency.
`BLOP_AGENT_BASE_URL` overrides the OpenAI-compatible provider endpoint, not the
app URL. Claude and Gemini models can be routed through OpenRouter. Never commit
API keys or put them in goal text.

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

Adapt expectations to your application. `agent.goto` and `agent.goal` build ordered
instructions, not direct Playwright operations. The agent chooses interactions;
`browser_expect_*` tools evaluate objective state. A screenshot or a successful
click does not replace an outcome assertion. `defineAgentTest` supports object-form
specs; `runBlopTest` and `runBlopTests` provide programmatic execution. Import these
and testing types such as `BlopConfig` from `@blopai/test`, not `@blopai/cli`.

## Investigate and reverify

Use `blop list` to check discovery, then run a focused spec against a running app
with known seed data, an explicit target, and a bounded `--max-steps`. Inspect
`results.json`, `events.jsonl`, critical points, tool feedback, and referenced
screenshots in the report directory (`.blop` by default). Use distinct directories
for before/after runs and rerun the same check after a fix.

`failed` is an unmet goal; `error` is failure to complete normally, such as a
browser, timeout, provider, or agent runtime failure. Neither a runtime error nor
provider prose proves an application defect. Results retain `attempts`,
`firstAttemptStatus`, and `resumes`: a pass after an initially non-passing attempt
is flake; a same-context agent resume is not a retry. Keep failed evidence rather
than increasing retries until green. In CI, pin provider/model, use secret injection,
install Chromium, and upload report artifacts even on failure; `--reporter all`
includes `report.xml` for JUnit consumers.

## Coverage and local inspector

```bash
blop up --detach --no-open
# Substitute the actual collector base URL printed by blop up if different.
pnpm exec blop test tests/catalog.blop.ts --base-url http://localhost:3000 \
  --browser chromium --coverage --coverage-endpoint http://127.0.0.1:27811
```

`--coverage` is opt-in and Chromium-only and writes `.blop/coverage.json` (or under
`--report-dir`). `--coverage-endpoint` is optional: it posts to the collector's
`/api/test-coverage` and does not start a server. Open `/inspector?view=coverage`
for the latest uploaded report, source-character percentages, source annotations,
associated tests, and warnings. The report is separate from trace storage; no
run/trace join or hosted dependency is implied. Programmatic options are
`coverage: true` and `coverageEndpoint`; report types/helpers are available from
`@blopai/test/coverage`.

Coverage measures unioned executed UTF-16 source-character ranges of named loaded
JavaScript scripts. Anonymous scripts are excluded. This is not statement/branch coverage, backend coverage, source-map
attribution, or unloaded-file coverage. Popups, closed pages and missing source can
leave gaps. Collection retains at most 200 script versions, 1 Mi UTF-16 characters
per source, 20,000 ranges per script, 100,000 ranges total and 5 MiB of serialized
file evidence. The wire limit is 8 MiB. Oversized measurements are excluded with
source-specific warnings; percentages describe retained evidence, not completeness.
No collected scripts means unavailable, not 100%. Assertions still determine
correctness. Reports include source and URLs: review sharing and retention.

## Package layout and verification

```text
src/runtime/    DSL, agent loop, runner, public testing types
src/reporters/  local reports and optional OpenTelemetry events
src/platform/   optional hosted upload boundary
src/node/       config, CI metadata, browser launch, OTel config
src/coverage.ts shared coverage report contract and helpers
test/           deterministic runtime/browser/reporter/platform regressions
tests/          real authored .blop.ts examples
templates/      starter specs consumed by CLI scaffolding
bench/          browser and agent benchmarks
```

The authored examples include [Example Domain](tests/example-url-open.blop.ts),
[products](tests/elusive-products.blop.ts), [product detail](tests/elusive-product-detail.blop.ts),
and [signup](tests/elusive-signup.blop.ts). Signup creates an account on a live
site: do not run it as a default smoke check. Review permission, synthetic identities,
cleanup, and artifact retention; prefer a controlled staging equivalent. Absolute
URLs in specs are not redirected by `--base-url`.

For contributors, install with `pnpm install` at the workspace root, then use
`pnpm --filter @blopai/test build`, `typecheck`, `test`, or `test:vitest` as appropriate.
CLI-specific tests stay in `packages/blop/test/e2e`; runtime tests live here.
See [AGENTS.md](AGENTS.md) and the full
[agent testing guide](../../apps/docs/content/guides/agent-testing.mdx).

## Release

Publish this package before a CLI version that depends on it. Tags
`test-v<package.json version>` trigger `.github/workflows/release-test.yml`;
configure that workflow as an npm trusted publisher after the initial package
publication. The CLI release verifies that its testing dependency is available
from npm before publishing. No compatibility testing exports remain in the CLI.
