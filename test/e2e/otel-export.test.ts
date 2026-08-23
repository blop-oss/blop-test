import { afterEach, describe, expect, test } from "bun:test";
import type { BlopOtelConfig } from "../../src/node/otel-config";
import { failureCategory, journeyId, sanitizeUrl, startOtelRun } from "../../src/reporters/otel";
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
const SPAN_KIND_SERVER = 2;
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
  const server = await startFixtureServer([
    {
      path: "/v1/traces",
      body: "{}",
      contentType: "application/json",
      onRequest: (_request, body) => {
        payloads.push(body);
      },
    },
  ]);
  closeServer = server.close;

  return {
    url: server.url,
    config: (overrides: Partial<BlopOtelConfig> = {}): BlopOtelConfig => ({
      tracesUrl: `${server.url}/v1/traces`,
      headers: {},
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
    scenario.end({ status: "passed", reason: "Discount applied.", attempts: 1 });

    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

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

    expect(runSpan!.kind).toBe(SPAN_KIND_SERVER);
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
    scenario.end({ status: "passed", reason: "ok", attempts: 1 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

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
    await run.end({ status: "failed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

    const runSpan = byName(collector.spans(), "blop run checkout")!;

    expect(attr(runSpan, "cicd.pipeline.name")).toBe("QA");
    expect(attr(runSpan, "cicd.pipeline.action.name")).toBe("RUN");
    expect(attr(runSpan, "cicd.pipeline.run.id")).toBe("120912");
    expect(attr(runSpan, "cicd.pipeline.result")).toBe("failure");
    expect(attr(runSpan, "vcs.repository.url.full")).toBe("https://github.com/blop-oss/blop-app");
    expect(attr(runSpan, "vcs.ref.head.name")).toBe("feature/checkout");
    expect(attr(runSpan, "vcs.ref.head.type")).toBe("branch");
    expect(attr(runSpan, "vcs.change.id")).toBe("123");
    expect(attr(runSpan, "test.suite.run.status")).toBe("failure");
  });

  test("omits cicd attributes entirely when not running in CI", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "local",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

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
    scenario.end({ status: "passed", reason: "ok", attempts: 1 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

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
    scenario.end({ status: "passed", reason: "ok", attempts: 1 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

    const spans = collector.spans();
    const type = byName(spans, "browser_type")!;
    expect(attr(type, "blop.step.target")).toBe("Password field");

    // Basic-auth credentials in the target URL never reach the collector.
    const scenarioSpan = byName(spans, "checkout > login")!;
    expect(attr(scenarioSpan, "blop.base_url")).toBe("https://staging.example.com/");

    // Typed text and tool output must never reach the collector.
    const serialized = JSON.stringify(type);
    expect(serialized).not.toContain("hunter2-secret");
    expect(serialized).not.toContain("DOM snapshot");
  });

  test("records bookkeeping tools and batches as events rather than steps", async () => {
    const collector = await startCollector();
    const run = startOtelRun(collector.config(), {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date("2026-08-23T10:00:00.000Z"),
      ci: NO_CI,
    });

    const scenario = run.startScenario({ name: "checkout > batched" });
    scenario.recordStep(action("browser_goto"));
    // The harness records inner steps first, then the batch wrapper.
    scenario.recordStep(action("browser_click"));
    scenario.recordStep(action("browser_run_steps"));
    scenario.recordStep(action("record_critical_point"));
    scenario.recordStep(action("finish_test"));
    scenario.end({ status: "passed", reason: "ok", attempts: 1 });
    await run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

    const spans = collector.spans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      "blop run checkout",
      "browser_click",
      "browser_goto",
      "checkout > batched",
    ]);

    const scenarioSpan = byName(spans, "checkout > batched")!;
    expect((scenarioSpan.events ?? []).map((event) => event.name).sort()).toEqual([
      "browser_run_steps",
      "finish_test",
      "record_critical_point",
    ]);
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
    });
    await run.end({ status: "failed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

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

  test("marks a failing step with its error", async () => {
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
    scenario.end({ status: "failed", reason: "Could not click checkout.", attempts: 1 });
    await run.end({ status: "failed", finishedAt: new Date("2026-08-23T10:00:30.000Z") });

    const click = byName(collector.spans(), "browser_click")!;
    expect(click.status?.code).toBe(STATUS_CODE_ERROR);
    expect(click.status?.message).toContain("stale element reference");
  });

  test("an unreachable collector never fails the run", async () => {
    const run = startOtelRun(
      {
        // Nothing is listening here; the export must fail silently.
        tracesUrl: "http://127.0.0.1:1/v1/traces",
        headers: {},
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
    scenario.end({ status: "passed", reason: "ok", attempts: 1 });

    await expect(
      run.end({ status: "passed", finishedAt: new Date("2026-08-23T10:00:30.000Z") }),
    ).resolves.toBeUndefined();
  });
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
});
