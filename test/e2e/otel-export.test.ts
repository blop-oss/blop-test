import { afterEach, describe, expect, test } from "bun:test";
import type { BlopOtelConfig } from "../../src/node/otel-config";
import { failureCategory, resolveFailureCategory, journeyId, sanitizeUrl, startOtelRun } from "../../src/reporters/otel";
import type { BlopAction, BlopCiMetadata } from "../../src/runtime/types";
import { startFixtureServer } from "../test-utils/server";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

// OTLP/HTTP JSON wire shapes, narrowed to what these assertions read.
type OtlpValue = Record<string, string | number | boolean>;
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: Array<{ key: string; value: OtlpValue }>;
  status?: { code?: number; message?: string };
  events?: Array<{ name: string; attributes?: Array<{ key: string; value: OtlpValue }> }>;
};

const SPAN_KIND_INTERNAL = 1;
const STATUS_CODE_ERROR = 2;

const NO_CI: BlopCiMetadata = {
  provider: null,
  runId: null,
  jobId: null,
  branch: null,
  commitSha: null,
  pullRequest: null,
  repositoryUrl: null,
  workflowName: null,
  runAttempt: null,
  runUrl: null,
  refType: null,
  pullRequestNumber: null,
};

const GITHUB_CI: BlopCiMetadata = {
  provider: "github-actions",
  runId: "120912",
  jobId: "e2e",
  branch: "feature/checkout",
  commitSha: "9d59409acf479dfa0df1aa568182e43e43df8bbe",
  pullRequest: "refs/pull/123/merge",
  repositoryUrl: "https://github.com/blop-oss/blop-app",
  workflowName: "QA",
  runAttempt: "2",
  runUrl: "https://github.com/blop-oss/blop-app/actions/runs/120912",
  refType: "branch",
  pullRequestNumber: "123",
};

/** Stand in for the harness's post-completion action record. */
function action(name: string, overrides: Partial<BlopAction> = {}): BlopAction {
  return {
    name,
    input: {},
    output: "ok",
    timestamp: new Date("2026-08-23T10:00:05.000Z").toISOString(),
    durationMs: 250,
    ...overrides,
  };
}

async function startCollector() {
  const payloads: string[] = [];
  const metricPayloads: string[] = [];
  const logPayloads: string[] = [];
  const server = await startFixtureServer([
    {
      path: "/v1/traces",
      body: "{}",
      contentType: "application/json",
      onRequest: (_request, body) => {
        payloads.push(body);
      },
    },
    {
      path: "/v1/metrics",
      body: "{}",
      contentType: "application/json",
      onRequest: (_request, body) => {
        metricPayloads.push(body);
      },
    },
    {
      path: "/v1/logs",
      body: "{}",
      contentType: "application/json",
      onRequest: (_request, body) => {
        logPayloads.push(body);
      },
    },
  ]);
  closeServer = server.close;

  return {
    url: server.url,
    metrics: () => metricPayloads.flatMap(collectMetrics),
    logRecords: () => logPayloads.flatMap(collectLogs),
    config: (overrides: Partial<BlopOtelConfig> = {}): BlopOtelConfig => ({
      tracesUrl: `${server.url}/v1/traces`,
      metricsUrl: `${server.url}/v1/metrics`,
      logsUrl: `${server.url}/v1/logs`,
      tracesProtocol: "http/json",
      metricsProtocol: "http/json",
      logsProtocol: "http/json",
      headers: {},
      metricsHeaders: {},
      logsHeaders: {},
      serviceName: "blop-runner",
      propagateToApp: false,
      propagateAllowlist: [],
      ...overrides,
    }),
    spans: () => payloads.flatMap(collectSpans),
    resourceAttributes: () => {
      const parsed = payloads.map((payload) => JSON.parse(payload));
      return (parsed[0]?.resourceSpans?.[0]?.resource?.attributes ?? []) as Array<{
        key: string;
        value: OtlpValue;
      }>;
    },
  };
}

function collectSpans(payload: string): OtlpSpan[] {
  const parsed = JSON.parse(payload) as {
    resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
  };
  return (parsed.resourceSpans ?? []).flatMap((resource) =>
    (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
  );
}

type OtlpMetric = {
  name: string;
  unit?: string;
  sum?: { aggregationTemporality?: number; dataPoints?: OtlpPoint[] };
  histogram?: { aggregationTemporality?: number; dataPoints?: OtlpPoint[] };
};
type OtlpPoint = {
  attributes?: Array<{ key: string; value: OtlpValue }>;
  asInt?: string;
  asDouble?: number;
  count?: string;
  sum?: number;
};
type OtlpLog = {
  body?: OtlpValue & { kvlistValue?: { values: Array<{ key: string; value: OtlpValue }> } };
  traceId?: string;
  spanId?: string;
  attributes?: Array<{ key: string; value: OtlpValue }>;
};

function collectMetrics(payload: string): OtlpMetric[] {
  const parsed = JSON.parse(payload) as {
    resourceMetrics?: Array<{ scopeMetrics?: Array<{ metrics?: OtlpMetric[] }> }>;
  };
  return (parsed.resourceMetrics ?? []).flatMap((resource) =>
    (resource.scopeMetrics ?? []).flatMap((scope) => scope.metrics ?? []),
  );
}

function collectLogs(payload: string): OtlpLog[] {
  const parsed = JSON.parse(payload) as {
    resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: OtlpLog[] }> }>;
  };
  return (parsed.resourceLogs ?? []).flatMap((resource) =>
    (resource.scopeLogs ?? []).flatMap((scope) => scope.logRecords ?? []),
  );
}

function points(metric: OtlpMetric | undefined): OtlpPoint[] {
  return metric?.sum?.dataPoints ?? metric?.histogram?.dataPoints ?? [];
}

function attr(
  source: { attributes?: Array<{ key: string; value: OtlpValue }> } | undefined,
  key: string,
): string | number | boolean | undefined {
  const found = source?.attributes?.find((entry) => entry.key === key);
  if (!found) return undefined;
  const [value] = Object.values(found.value);
  return value;
}

function byName(spans: OtlpSpan[], name: string): OtlpSpan | undefined {
  return spans.find((span) => span.name === name);
}

function durationMs(span: OtlpSpan): number {
  return (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6;
}

describe("otel export", () => {
  test("exports one trace per run shaped run > scenario > step", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });

    const scenario = run.startScenario({
      name: "checkout > applies discount",
      specFile: "/repo/tests/checkout.blop.ts",
      baseUrl: "https://staging.example.com",
    });
    scenario.beginAttempt(1);
    scenario.recordStep(action("browser_goto", { input: { url: "https://staging.example.com" } }));
    scenario.recordStep(action("browser_click", { input: { target: "Checkout button" } }));
    scenario.end({ status: "passed", reason: "Discount applied.", attempts: 1, durationMs: 1250 });

    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    const runSpan = byName(spans, "blop run checkout");
    const scenarioSpan = byName(spans, "checkout > applies discount");
    const goto = byName(spans, "browser_goto");
    const click = byName(spans, "browser_click");

    expect(spans).toHaveLength(4);
    expect(runSpan).toBeDefined();
    expect(scenarioSpan).toBeDefined();

    // One trace, correctly parented, and nested no deeper than the step.
    const traceIds = new Set(spans.map((span) => span.traceId));
    expect(traceIds.size).toBe(1);
    expect(runSpan!.parentSpanId ?? "").toBe("");
    expect(scenarioSpan!.parentSpanId).toBe(runSpan!.spanId);
    expect(goto!.parentSpanId).toBe(scenarioSpan!.spanId);
    expect(click!.parentSpanId).toBe(scenarioSpan!.spanId);

    expect(runSpan!.kind).toBe(SPAN_KIND_INTERNAL);
    expect(scenarioSpan!.kind).toBe(SPAN_KIND_INTERNAL);
    expect(goto!.kind).toBe(SPAN_KIND_INTERNAL);
  });

  test("carries the semantic-convention attributes for suite, case and agent", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config({ serviceName: "blop-ci" }), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });

    const scenario = run.startScenario({
      name: "checkout > applies discount",
      specFile: "/repo/tests/checkout.blop.ts",
      baseUrl: "https://staging.example.com",
    });
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    const runSpan = byName(spans, "blop run checkout")!;
    const scenarioSpan = byName(spans, "checkout > applies discount")!;

    expect(attr({ attributes: collector.resourceAttributes() }, "service.name")).toBe("blop-ci");

    expect(attr(runSpan, "test.suite.name")).toBe("checkout");
    expect(attr(runSpan, "test.suite.run.status")).toBe("success");
    expect(attr(runSpan, "blop.run.id")).toBe("run_abc");
    expect(attr(runSpan, "blop.agent.provider")).toBe("openrouter");
    expect(attr(runSpan, "blop.agent.model")).toBe("anthropic/claude-sonnet-4");

    expect(attr(scenarioSpan, "test.case.name")).toBe("checkout > applies discount");
    expect(attr(scenarioSpan, "test.case.result.status")).toBe("pass");
    expect(attr(scenarioSpan, "blop.journey.id")).toBe("checkout");
    expect(attr(scenarioSpan, "blop.scenario.path")).toBe("/repo/tests/checkout.blop.ts");
  });

  test("maps CI metadata onto the cicd and vcs conventions", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: GITHUB_CI,
    });
    await run.end({ status: "failed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const runSpan = byName(collector.spans(), "blop run checkout")!;

    expect(attr(runSpan, "cicd.pipeline.name")).toBe("QA");
    expect(attr(runSpan, "cicd.pipeline.action.name")).toBe("RUN");
    expect(attr(runSpan, "cicd.pipeline.run.id")).toBe("120912");
    // cicd.pipeline.result is intentionally not set: the test process cannot
    // know the workflow's final result.
    expect(attr(runSpan, "cicd.pipeline.result")).toBeUndefined();
    expect(attr(runSpan, "vcs.repository.url.full")).toBe("https://github.com/blop-oss/blop-app");
    expect(attr(runSpan, "vcs.ref.head.name")).toBe("feature/checkout");
    expect(attr(runSpan, "vcs.ref.head.type")).toBe("branch");
    expect(attr(runSpan, "vcs.change.id")).toBe("123");
    expect(attr(runSpan, "test.suite.run.status")).toBe("failure");
  });

  test("uses the standard timed_out suite status", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_timeout",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    await run.end({
      status: "error",
      timedOut: true,
      finishedAt: new Date("2026-08-23T10:00:30.000Z"),
      durationMs: 30_000,
    });

    const runSpan = byName(collector.spans(), "blop run checkout")!;
    expect(attr(runSpan, "test.suite.run.status")).toBe("timed_out");
  });

  test("omits cicd attributes entirely when not running in CI", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "local",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const runSpan = byName(collector.spans(), "blop run local")!;
    expect(attr(runSpan, "cicd.pipeline.result")).toBeUndefined();
    expect(attr(runSpan, "cicd.pipeline.action.name")).toBeUndefined();
    expect(attr(runSpan, "vcs.repository.url.full")).toBeUndefined();
  });

  test("back-dates step spans from the duration the harness measured", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > slow step" });
    scenario.recordStep(
      action("browser_goto", {
        timestamp: "2026-08-23T10:00:05.000Z",
        durationMs: 1500,
        input: { url: "https://staging.example.com/cart" },
      }),
    );
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const goto = byName(collector.spans(), "browser_goto")!;
    expect(durationMs(goto)).toBe(1500);
    expect(Number(goto.endTimeUnixNano) / 1e6).toBe(Date.parse("2026-08-23T10:00:05.000Z"));
    expect(attr(goto, "blop.step.url")).toBe("https://staging.example.com/cart");
  });

  test("keeps payloads out of spans, carrying only where the step acted", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({
      name: "checkout > login",
      baseUrl: "https://deploy:preview-pw@staging.example.com",
    });
    scenario.recordStep(
      action("browser_type", {
        input: { target: "Password field", text: "hunter2-secret" },
        output: "<html>a very long DOM snapshot</html>",
      }),
    );
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    const type = byName(spans, "browser_type")!;
    // Arbitrary target/selector text is never exported; only the sanitized URL.
    expect(attr(type, "blop.step.target")).toBeUndefined();

    // Basic-auth credentials in the target URL never reach the collector.
    const scenarioSpan = byName(spans, "checkout > login")!;
    expect(attr(scenarioSpan, "blop.base_url")).toBe("https://staging.example.com/");

    // Typed text and tool output must never reach the collector.
    const serialized = JSON.stringify(type);
    expect(serialized).not.toContain("hunter2-secret");
    expect(serialized).not.toContain("DOM snapshot");
    expect(serialized).not.toContain("Password field");
  });

  test("nests the inner steps of a batching tool under it", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > batched" });

    // The runner opens a live span before the tool runs. browser_run_steps
    // executes its inner tools internally, so their actions land while the
    // batch span is still open.
    const batch = scenario.beginStep("browser_run_steps", {});
    scenario.recordStep(action("browser_goto"));
    scenario.recordStep(action("browser_click"));
    scenario.recordStep(action("browser_run_steps"));
    batch.end();

    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    const batchSpan = byName(spans, "browser_run_steps")!;
    const goto = byName(spans, "browser_goto")!;
    const click = byName(spans, "browser_click")!;

    // Exactly one span for the batch, with its children beneath it rather than
    // as siblings that overlap it.
    expect(spans.filter((span) => span.name === "browser_run_steps")).toHaveLength(1);
    expect(goto.parentSpanId).toBe(batchSpan.spanId);
    expect(click.parentSpanId).toBe(batchSpan.spanId);
    expect(batchSpan.parentSpanId).toBe(byName(spans, "checkout > batched")!.spanId);
  });

  test("keeps bookkeeping tools as events rather than steps", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > bookkeeping" });
    for (const name of ["record_critical_point", "finish_test"]) {
      const step = scenario.beginStep(name, {});
      scenario.recordStep(action(name));
      step.end();
    }
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      "blop run checkout",
      "checkout > bookkeeping",
    ]);
    expect((byName(spans, "checkout > bookkeeping")!.events ?? []).map((e) => e.name).sort()).toEqual([
      "finish_test",
      "record_critical_point",
    ]);
  });

  test("does not duplicate a span when the harness reports the tool it already opened", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > single" });
    const step = scenario.beginStep("browser_goto", { url: "https://staging.example.com" });
    scenario.recordStep(action("browser_goto", { metadata: { error: "Navigation failed" } }));
    step.end();
    scenario.end({ status: "failed", reason: "Could not load.", attempts: 1, durationMs: 1250 });
    await run.end({ status: "failed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    const goto = spans.filter((span) => span.name === "browser_goto");
    expect(goto).toHaveLength(1);
    // The post-completion record enriches the live span instead of adding one.
    expect(goto[0]!.status?.code).toBe(STATUS_CODE_ERROR);
    expect(attr(goto[0], "blop.step.url")).toBe("https://staging.example.com/");
  });

  test("nests a retry attempt in its own span and flags the failure", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > flaky" });
    scenario.beginAttempt(1);
    scenario.recordStep(action("browser_goto"));
    scenario.beginAttempt(2);
    scenario.recordStep(action("browser_click"));
    scenario.recordResume(1, 2);
    scenario.end({
      status: "failed",
      reason: "Test timed out after 30000ms",
      attempts: 2,
      durationMs: 1250,
    });
    await run.end({ status: "failed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    const scenarioSpan = byName(spans, "checkout > flaky")!;
    const retry = byName(spans, "scenario.retry")!;

    // Attempt 1 hangs off the scenario; only the retry earns a span.
    expect(byName(spans, "browser_goto")!.parentSpanId).toBe(scenarioSpan.spanId);
    expect(retry.parentSpanId).toBe(scenarioSpan.spanId);
    expect(byName(spans, "browser_click")!.parentSpanId).toBe(retry.spanId);

    expect(attr(scenarioSpan, "test.case.result.status")).toBe("fail");
    expect(attr(scenarioSpan, "blop.failure.category")).toBe("timeout");
    expect(attr(scenarioSpan, "blop.scenario.attempts")).toBe(2);
    expect(scenarioSpan.status?.code).toBe(STATUS_CODE_ERROR);
    expect((retry.events ?? []).map((event) => event.name)).toEqual(["blop.agent.resume"]);
  });

  test("marks a failing step with an ERROR status and no raw reason message", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > broken" });
    scenario.recordStep(
      action("browser_click", { metadata: { error: 'Unknown or stale element reference "e6".' } }),
    );
    scenario.end({ status: "failed", reason: "Could not click checkout.", attempts: 1, durationMs: 1250 });
    await run.end({ status: "failed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const click = byName(collector.spans(), "browser_click")!;
    expect(click.status?.code).toBe(STATUS_CODE_ERROR);
    // The raw error string must never reach the collector as a span message.
    expect(click.status?.message).toBeUndefined();
    const serialized = JSON.stringify(click);
    expect(serialized).not.toContain("stale element reference");

    // The scenario span carries the bounded failure category, not the reason.
    const scenarioSpan = byName(collector.spans(), "checkout > broken")!;
    expect(scenarioSpan.status?.code).toBe(STATUS_CODE_ERROR);
    expect(scenarioSpan.status?.message).toBeUndefined();
    expect(attr(scenarioSpan, "blop.failure.category")).toBe("assertion");
    const scenarioSerialized = JSON.stringify(scenarioSpan);
    expect(scenarioSerialized).not.toContain("Could not click checkout.");
  });

  test("exports metrics in seconds with delta temporality and no per-run dimensions", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
      team: "payments",
    });

    const scenario = run.startScenario({ name: "checkout > applies discount" });
    scenario.beginAttempt(1);
    scenario.beginAttempt(2);
    scenario.recordResume(1, 2);
    scenario.recordTokens({ input: 1200, output: 340, cache_read: 0, cache_write: 12 });
    scenario.end({ status: "passed", reason: "ok", attempts: 2, durationMs: 2500 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const metrics = collector.metrics();
    const duration = metrics.find((metric) => metric.name === "blop.scenario.duration");
    const recoveries = metrics.find((metric) => metric.name === "blop.agent.recoveries");
    const tokens = metrics.find((metric) => metric.name === "blop.agent.tokens");

    // Semantic conventions require seconds for durations.
    expect(duration?.unit).toBe("s");
    expect(points(duration)[0]?.sum).toBe(2.5);

    // DELTA is 1 in the OTLP enum; CUMULATIVE (2) would strand a series per run.
    expect(duration?.histogram?.aggregationTemporality).toBe(1);
    expect(recoveries?.sum?.aggregationTemporality).toBe(1);

    // A retry and a resume, tracked separately.
    expect(
      points(recoveries)
        .map((point) => attr(point, "blop.recovery.kind"))
        .sort(),
    ).toEqual(["resume", "retry"]);

    // Zero-valued token kinds are skipped rather than emitted as empty series.
    expect(
      points(tokens)
        .map((point) => attr(point, "blop.token.kind"))
        .sort(),
    ).toEqual(["cache_write", "input", "output"]);
    expect(points(tokens).every((point) => attr(point, "blop.team") === "payments")).toBe(true);

    // Run and scenario ids would explode customer cardinality.
    for (const metric of metrics) {
      for (const point of points(metric)) {
        expect(attr(point, "blop.run.id")).toBeUndefined();
        expect(attr(point, "test.case.name")).toBeUndefined();
        expect(attr(point, "blop.scenario.path")).toBeUndefined();
      }
    }
  });

  test("mirrors the CloudEvent taxonomy onto log records with trace context", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
      projectId: "proj_123",
    });

    const scenario = run.startScenario({ name: "checkout > applies discount" });
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const records = collector.logRecords();
    const types = records.map((record) => attr(record, "cloudevents.event_type"));

    // The three types that actually exist in the taxonomy, unchanged.
    expect(types).toEqual([
      "qa.run.started.v1",
      "qa.run.step.finished.v1",
      "qa.run.finished.v1",
    ]);

    const spans = collector.spans();
    const runSpan = byName(spans, "blop run checkout")!;
    const scenarioSpan = byName(spans, "checkout > applies discount")!;

    // Correlated to the run trace, and the scenario event to its own span.
    expect(records.every((record) => record.traceId === runSpan.traceId)).toBe(true);
    expect(records[1]!.spanId).toBe(scenarioSpan.spanId);
    expect(records[0]!.spanId).toBe(runSpan.spanId);

    expect(attr(records[0], "cloudevents.event_source")).toBe("urn:blop:runner:cli:run_abc");
    expect(attr(records[0], "cloudevents.event_spec_version")).toBe("1.0");
    expect(attr(records[0], "cloudevents.event_subject")).toBe("run_abc");

    const body = records[2]!.body?.kvlistValue?.values ?? [];
    expect(attr({ attributes: body }, "status")).toBe("passed");
    expect(attr({ attributes: body }, "project_id")).toBe("proj_123");
  });

  test("still exports a scenario the runner abandoned mid-flight", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    // The runner can throw outside a guarded region (creating a page, starting
    // the screencast) and never reach scenario.end. An unended span is never
    // exported, losing the trace for exactly the failure worth seeing.
    const scenario = run.startScenario({ name: "checkout > abandoned" });
    scenario.beginStep("browser_goto", {});

    await run.end({ status: "error", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const spans = collector.spans();
    const scenarioSpan = byName(spans, "checkout > abandoned");
    expect(scenarioSpan).toBeDefined();
    expect(scenarioSpan!.status?.code).toBe(STATUS_CODE_ERROR);
    expect(attr(scenarioSpan, "blop.failure.category")).toBe("abandoned");
    // The open step span is closed too, rather than dropped.
    expect(byName(spans, "browser_goto")).toBeDefined();

    // No duration is known, so nothing is recorded that would skew the histogram.
    const duration = collector.metrics().find((metric) => metric.name === "blop.scenario.duration");
    expect(points(duration)).toHaveLength(0);
  });

  test("counts cumulative usage totals once, not once per streamed chunk", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > tokens" });

    // prompt_tokens/completion_tokens are running totals for the request, and
    // the agent loop re-emits a usage event for every chunk carrying one.
    scenario.beginLlmCall();
    scenario.recordTokens({ input: 100, output: 10, cache_read: 0, cache_write: 0 });
    scenario.recordTokens({ input: 100, output: 25, cache_read: 0, cache_write: 0 });
    scenario.recordTokens({ input: 100, output: 40, cache_read: 0, cache_write: 0 });

    // A second call starts its own totals.
    scenario.beginLlmCall();
    scenario.recordTokens({ input: 50, output: 5, cache_read: 0, cache_write: 0 });

    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    const tokens = collector.metrics().find((metric) => metric.name === "blop.agent.tokens");
    const byKind = Object.fromEntries(
      points(tokens).map((point) => [attr(point, "blop.token.kind"), Number(point.asInt ?? point.asDouble)]),
    );

    // 100 + 50, not 100 + 100 + 100 + 50.
    expect(byKind.input).toBe(150);
    // 40 + 5, not 10 + 25 + 40 + 5.
    expect(byKind.output).toBe(45);
  });

  test("exports no metrics or logs when only a traces endpoint is configured", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config({ metricsUrl: null, logsUrl: null }), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > traces only" });
    scenario.recordTokens({ input: 10, output: 5 });
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    expect(collector.spans().length).toBeGreaterThan(0);
    expect(collector.metrics()).toHaveLength(0);
    expect(collector.logRecords()).toHaveLength(0);
  });

  test("exports metrics only when only a metrics endpoint is configured", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config({ tracesUrl: null, logsUrl: null }), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > metrics only" });
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 2500 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    // No traces or logs are exported, but metrics still arrive.
    expect(collector.spans()).toHaveLength(0);
    expect(collector.logRecords()).toHaveLength(0);
    const duration = collector.metrics().find((metric) => metric.name === "blop.scenario.duration");
    expect(points(duration)).toHaveLength(1);
    expect(points(duration)[0]?.sum).toBe(2.5);
  });

  test("exports logs only when only a logs endpoint is configured", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config({ tracesUrl: null, metricsUrl: null }), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
      projectId: "proj_123",
    });

    const scenario = run.startScenario({ name: "checkout > logs only" });
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    expect(collector.spans()).toHaveLength(0);
    expect(collector.metrics()).toHaveLength(0);
    // CloudEvent log records still arrive, correlated to the run trace even
    // though traces themselves are not exported.
    const records = collector.logRecords();
    expect(records.length).toBeGreaterThan(0);
    const types = records.map((record) => attr(record, "cloudevents.event_type"));
    expect(types).toContain("qa.run.started.v1");
    expect(types).toContain("qa.run.finished.v1");
    // Each log record carries a traceId/spanId (the run context is maintained
    // for log correlation even with traces export off).
    expect(records.every((record) => typeof record.traceId === "string" && record.traceId.length === 32)).toBe(true);
    expect(records.every((record) => typeof record.spanId === "string" && record.spanId.length === 16)).toBe(true);
  });

  test("traceContext returns a valid W3C traceparent for the run root", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const ctx = run.traceContext();
    // W3C traceparent: version-traceid-spanid-flags
    expect(ctx.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);

    const [version, traceId, spanId, flags] = ctx.traceparent.split("-");
    expect(version).toBe("00");
    expect(traceId).toMatch(/[0-9a-f]{32}/);
    expect(spanId).toMatch(/[0-9a-f]{16}/);
    // Runs are never sampled away, so the sampled flag is set.
    expect(flags).toBe("01");

    // The traceparent references the run root span exactly.
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });
    const runSpan = byName(collector.spans(), "blop run checkout")!;
    expect(traceId).toBe(runSpan.traceId);
    expect(spanId).toBe(runSpan.spanId);
  });

  test("traceContext is still available when traces export is off", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config({ tracesUrl: null }), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const ctx = run.traceContext();
    expect(ctx.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });
  });

  test("uses the http/protobuf exporter when the protocol is http/protobuf", async () => {
    const contentTypes: string[] = [];
    const server = await startFixtureServer([
      {
        path: "/v1/traces",
        body: Buffer.alloc(0).toString("binary"),
        contentType: "application/x-protobuf",
        onRequest: (request) => {
          contentTypes.push(request.headers["content-type"] as string);
        },
      },
    ]);
    closeServer = server.close;

    const run = startOtelRun(
      {
        tracesUrl: `${server.url}/v1/traces`,
        metricsUrl: null,
        logsUrl: null,
        tracesProtocol: "http/protobuf",
        metricsProtocol: "http/protobuf",
        logsProtocol: "http/protobuf",
        headers: {},
        metricsHeaders: {},
        logsHeaders: {},
        serviceName: "blop-runner",
        propagateToApp: false,
        propagateAllowlist: [],
      },
      {
        runId: "run_abc",
        suiteName: "checkout",
        startedAt: new Date("2026-08-23T10:00:00.000Z"),
        ci: NO_CI,
      },
    );
    const scenario = run.startScenario({ name: "checkout > proto" });
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 100 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    expect(contentTypes.some((ct) => ct === "application/x-protobuf")).toBe(true);
  });

  test("uses the http/json exporter when the protocol is http/json", async () => {
    const contentTypes: string[] = [];
    const server = await startFixtureServer([
      {
        path: "/v1/traces",
        body: "{}",
        contentType: "application/json",
        onRequest: (request) => {
          contentTypes.push(request.headers["content-type"] as string);
        },
      },
    ]);
    closeServer = server.close;

    const run = startOtelRun(
      {
        tracesUrl: `${server.url}/v1/traces`,
        metricsUrl: null,
        logsUrl: null,
        tracesProtocol: "http/json",
        metricsProtocol: "http/json",
        logsProtocol: "http/json",
        headers: {},
        metricsHeaders: {},
        logsHeaders: {},
        serviceName: "blop-runner",
        propagateToApp: false,
        propagateAllowlist: [],
      },
      {
        runId: "run_abc",
        suiteName: "checkout",
        startedAt: new Date("2026-08-23T10:00:00.000Z"),
        ci: NO_CI,
      },
    );
    const scenario = run.startScenario({ name: "checkout > json" });
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 100 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 });

    expect(contentTypes.some((ct) => ct === "application/json")).toBe(true);
  });

  test("an unreachable collector never fails the run", async () => {
    const run = startOtelRun(
      {
        // Nothing is listening here; the export must fail silently.
        tracesUrl: "http://127.0.0.1:1/v1/traces",
        metricsUrl: "http://127.0.0.1:1/v1/metrics",
        logsUrl: "http://127.0.0.1:1/v1/logs",
        tracesProtocol: "http/protobuf",
        metricsProtocol: "http/protobuf",
        logsProtocol: "http/protobuf",
        headers: {},
        metricsHeaders: {},
        logsHeaders: {},
        serviceName: "blop-runner",
        propagateToApp: false,
        propagateAllowlist: [],
      },
      {
        runId: "run_abc",
        suiteName: "checkout",
        startedAt: new Date("2026-08-23T10:00:00.000Z"),
        ci: NO_CI,
      },
    );

    const scenario = run.startScenario({ name: "checkout > offline" });
    scenario.recordStep(action("browser_goto"));
    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 1250 });

    await expect(
      run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z"), durationMs: 30_000 }),
    ).resolves.toBeUndefined();
  }, 15_000);
});

describe("otel helpers", () => {
  test("journey id is the root describe block", () => {
    expect(journeyId("checkout > applies discount")).toBe("checkout");
    expect(journeyId("checkout > guest > applies discount")).toBe("checkout");
    expect(journeyId("standalone test")).toBe("standalone test");
    expect(journeyId("  spaced  > child")).toBe("spaced");
  });

  test("strips credentials and token parameters out of urls", () => {
    expect(sanitizeUrl("https://user:hunter2@staging.example.com/cart")).toBe(
      "https://staging.example.com/cart",
    );
    expect(sanitizeUrl("https://staging.example.com/?api_key=abc123&page=2")).toBe(
      "https://staging.example.com/?api_key=REDACTED&page=2",
    );
    expect(sanitizeUrl("https://staging.example.com/?sessionToken=abc")).toBe(
      "https://staging.example.com/?sessionToken=REDACTED",
    );
    // Left alone when there is nothing sensitive, or when it is not a URL.
    expect(sanitizeUrl("https://staging.example.com/cart?page=2")).toBe(
      "https://staging.example.com/cart?page=2",
    );
    expect(sanitizeUrl("/relative/path")).toBe("/relative/path");
  });

  test("failure category buckets the runner's own wording", () => {
    expect(failureCategory("error", "Test timed out after 30000ms")).toBe("timeout");
    expect(failureCategory("error", "The agent appears to be stuck: a short cycle repeated")).toBe("stall");
    expect(failureCategory("error", "The agent stopped after 4 action(s) without calling finish_test")).toBe(
      "agent_incomplete",
    );
    expect(failureCategory("error", "Failed to load spec file: boom")).toBe("infrastructure");
    expect(failureCategory("failed", "Expected the total to be 90.")).toBe("assertion");
    expect(failureCategory("error", "Something else entirely")).toBe("error");
  });

  test("reports the classified cause on blop.failure.category", () => {
    // #369: the attribute names the cause, not the symptom. The regex that
    // used to answer "assertion" survives only for a failure nothing can
    // classify.
    const out = resolveFailureCategory("failed", "boom", ["selector_no_match"], "browser_click");
    expect(out.category).toBe("selector_drift");
    expect(out.confidence).toBeGreaterThan(0);
  });

  test("falls back to the old regex bucket when nothing can be classified", () => {
    const out = resolveFailureCategory("failed", "Test timed out after 30000ms", [], null);
    expect(out.category).toBe("timeout");
    // A null confidence is the reliable marker that a value came from the
    // fallback rather than from the classifier.
    expect(out.confidence).toBeNull();
  });
});

describe("module graph", () => {
  test("the runner does not statically import the OpenTelemetry SDK", async () => {
    // The docs promise the SDK is never loaded without a configured endpoint,
    // and a static import would also drag it into every consumer of the
    // package, including `await import("@blopai/cli")` in the web app.
    const source = await Bun.file(new URL("../../src/runtime/runner.ts", import.meta.url)).text();

    const staticOtelImport = /^import\s+(?!type\b)[^;]*from\s+["'][^"']*(?:@opentelemetry|reporters\/otel)/m;
    expect(staticOtelImport.test(source)).toBe(false);
    // It is still reachable, just lazily.
    expect(source).toContain('await import("../reporters/otel.js")');
  });
});
