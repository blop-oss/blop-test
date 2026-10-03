# Agent instructions (packages/test)

`@blopai/test` is the active agent E2E library. It owns test authoring, execution,
evidence, reporters, and optional coverage/upload. `@blopai/cli` owns monitoring,
skills, and command routing and consumes this package's public exports. Keep the
two data planes separate: a run is not a trace and no storage join is implied.

Public docs live in [apps/docs/content](../../apps/docs/content); synchronize DSL,
options, output, and coverage descriptions when changing public behavior. The
[agent testing guide](../../apps/docs/content/guides/agent-testing.mdx) describes
writing, running, investigating, and reverifying actual checks.

## Ownership and layout

- `src/runtime/`: DSL, spec loader, agent loop, runner, evidence, public types.
- `src/reporters/`: JSON/event/JUnit output and OpenTelemetry export.
- `src/platform/`: optional hosted upload boundary.
- `src/node/`: config, CI metadata, browser launch, OTel config.
- `src/coverage.ts`: shared coverage report schema and helpers.
- `test/e2e/`, `test/node/`, `test/vitest/`: runtime regressions.
- `tests/`: real authored `.blop.ts` examples, separate from developer regressions.
- `templates/`: starter specs used by the CLI.
- `bench/`: browser/agent benchmark assets.

Browser tools, screencast, and container/CDP sessions belong in the sibling package
`@blopai/browser-harness`, not inlined here. Monitoring and skills stay under
`packages/blop`. Import testing APIs from `@blopai/test` and documented subpaths;
never add CLI compatibility reexports or import another package's internal `dist`.

## Runtime boundaries

- Preserve an agent-native executor; traditional testing frameworks validate the
  library but are not its product runtime.
- Keep the browser agent focused on E2E execution. The CLI skills subsystem is
  standalone and is not automatically wired into this agent loop.
- Controlled browser tools are the safety boundary. Do not add arbitrary shell or
  browser-script escape hatches without a concrete security review.
- The current agent loop and tools execute in-process; browser sessions can use
  local launch or remote CDP. A separate HTTP tool-server transport is not an
  implemented deployment guarantee.
- The native model loop uses OpenAI-compatible chat completions. Require an
  explicit model/key, support `BLOP_AGENT_*`, and route Claude/Gemini through
  OpenRouter. Do not document automatic provider-native key fallback.
- Keep app/goal failures distinct from browser, timeout, provider, or runtime
  errors. Keep retry/first-attempt evidence and distinguish same-context resumes
  from retries.
- Explicit local, CI, staging, or production targets need no hosted account.
  Production flows require permission, synthetic identities, least privilege,
  reversible actions, cleanup, and reviewed artifact retention.

## Authored checks and evidence

Coding agents may write reviewed goal-driven specs; the runtime must not silently
create or weaken a suite. State initial data, allowed actions, exact outcomes,
assertions, and forbidden side effects. `agent.goto` and `agent.goal` compose
ordered goals. Prefer objective `browser_expect_*` assertions, named screenshots,
and critical-point evidence; prose, screenshots, and successful clicks alone do
not prove all acceptance criteria.

Use `tests/example-url-open.blop.ts` and the elusive products/detail examples as
real authored references. `tests/elusive-signup.blop.ts` changes live-site state:
do not include it in routine verification without explicit permission and cleanup.
CLI base URL overrides do not replace absolute URLs inside a spec. After a fix,
rerun the same focused check and inspect results and artifacts before broadening
verification. A pass after retry is flake, not a clean first-attempt pass.

## Coverage contract

Coverage is opt-in `coverage: true` / `--coverage`, Chromium-only. Write
`coverage.json` under the report directory even without a collector endpoint.
Optional `coverageEndpoint` / `--coverage-endpoint` is an explicit collector base
URL, posting to `/api/test-coverage`; it never automatically starts a server.
The inspector's `view=coverage` consumes the latest report separately from traces.

Executed half-open UTF-16 source ranges are unioned across attempts. Describe the
metric as executed source characters of loaded JavaScript, not statements/branches,
backend code, source-mapped original files, or unloaded-file coverage. No scripts
means unavailable, never 100%. Preserve warnings for popup/closed-page limitations.
Reports contain source/URLs, so keep privacy and retention guidance visible.

## Verification

Install dependencies with `pnpm install` at the workspace root; use Bun for
package-local scripts. Build workspace dependencies before tests that read `dist`.
The verification owner should run the smallest relevant regressions first:

```bash
pnpm --filter @blopai/test build
pnpm --filter @blopai/test typecheck
pnpm --filter @blopai/test test
pnpm --filter @blopai/test test:vitest
```

Focused package-local examples:

```bash
bun test test/node/agent-loop.test.ts
bun test test/e2e/config.test.ts
```

Keep model calls mocked via `agentStream` for deterministic runner regressions;
prefer tiny local fixture servers over external sites. Browser tests may require
`pnpm exec playwright install chromium`. Reporter tests assert actual generated
files; platform tests use fixture HTTP servers and assert request/auth/payload
boundaries. CLI-specific routing tests remain in `packages/blop/test/e2e`.

Do not claim authored tests or unexecuted examples passed. Report exercised
commands and evidence; coordinate integrated verification rather than running
concurrent builds against partially edited packages.
