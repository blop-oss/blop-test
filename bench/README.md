# Browser-agent latency benchmarks

These assets investigate per-action screenshot overhead, screencast throughput,
and model-bound wall-clock behavior. They are not release gates or guarantees.
Historical timing numbers without a reproducible current run record are not
standalone performance claims. Keep all repetitions, failures, versions, browser
settings, and limitations when publishing a new measurement.

Run from the standalone repository root after:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build
bunx --no-install playwright install chromium
```

## Per-action screenshot overhead

```bash
bun run bench/micro.ts
```

`micro.ts` compares blocking JPEG screenshots against writing the latest CDP
screencast frame. It uses no model, but navigates to `https://example.com`, so it
is not an offline deterministic fixture. Review network access before running.
The script writes JPEG measurements under the OS temporary directory; delete
those artifacts according to your retention policy.

## Real-runner streaming throughput

```bash
bun run bench/stream-e2e.ts
```

This drives `runBlopTests` with a mocked model stream against a locally served
animated page, then reads progress NDJSON to measure frames and action evidence.
No provider credentials are needed. Build first so the package self-import
resolves. Generated progress/report evidence is ignored, not automatically
redacted or deleted. A model-free benchmark is not proof of live-agent task
correctness.

## Provider-backed authored smoke

`run.sh` delegates to an explicitly installed `blop` CLI executable, not a sibling
checkout or an internal source path. Install a CLI version compatible with the
library in the project running the check, and point `BLOP_CLI_BIN` at its binary
if it is not already on `PATH`. Before npm publication, maintainers must use an
actual built/pinned source dependency in that project rather than pretending an
unpublished registry version resolves. This library does not install the CLI.

Inject `BLOP_AGENT_PROVIDER`, `BLOP_AGENT_MODEL`, and `BLOP_AGENT_API_KEY` securely;
provider-native keys need explicit mapping. Optionally set `BLOP_AGENT_BASE_URL`
for an OpenAI-compatible endpoint. The script does not source `.env`, invent a
model, or automatically map chat settings. After reviewing authorization, costs,
spec imports, and absolute destinations, run:

```bash
bash bench/run.sh reviewed-example
```

The default spec is `bench/single.blop.ts`, which asks the agent to visit Example
Domain. An optional second argument selects another reviewed spec. The wrapper
uses a 40-step bound, captures screenshot/progress evidence, preserves the CLI's
exit status, prints elapsed seconds/action count, and refuses to overwrite an
existing label's evidence. Wall-clock includes model/network latency; pin settings
and compare repeated complete runs rather than the fastest result.

Do not select live signup, purchase, messaging, account changes, or destructive
flows without explicit permission, synthetic identities, cleanup, and retention
review. `tests/elusive-signup.blop.ts` changes a live account state and is not a
routine smoke test. Absolute URLs are not redirected by CLI `--base-url`.
Follow [PRIVACY.md](../PRIVACY.md), preserve every failure/error, and distinguish a
clean first-attempt pass from a pass after retry. No authored example is asserted
to pass merely because the repository CI passes.
