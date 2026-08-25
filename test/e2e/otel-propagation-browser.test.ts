import { afterEach, describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import { chromium, type Browser } from "playwright";
import type { BlopOtelConfig } from "../../src/node/otel-config";
import { startOtelRun } from "../../src/reporters/otel";
import type { BlopCiMetadata } from "../../src/runtime/types";
import { installTraceparentPropagation, shouldPropagateTo } from "../../src/runtime/otel-propagation";
import { startFixtureServer } from "../test-utils/server";

let closeServer: (() => Promise<void>) | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  await browser?.close();
  await closeServer?.();
  browser = undefined;
  closeServer = undefined;
});

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

describe("traceparent injection", () => {
  test("sends trace context to allowlisted hosts only, pointing at the live step span", async () => {
    const seen = new Map<string, string | undefined>();
    const server = await startFixtureServer([
      {
        path: "/",
        body: "<main><h1>fixture</h1></main>",
        onRequest: (request) => {
          const host = String(request.headers.host ?? "").split(":")[0]!;
          seen.set(host, request.headers.traceparent as string | undefined);
        },
      },
      { path: "/v1/traces", body: "{}", contentType: "application/json" },
      { path: "/v1/metrics", body: "{}", contentType: "application/json" },
      { path: "/v1/logs", body: "{}", contentType: "application/json" },
    ]);
    closeServer = server.close;
    const port = new URL(server.url).port;

    const config: BlopOtelConfig = {
      tracesUrl: `${server.url}/v1/traces`,
      metricsUrl: `${server.url}/v1/metrics`,
      logsUrl: `${server.url}/v1/logs`,
      headers: {},
      metricsHeaders: {},
      logsHeaders: {},
      serviceName: "blop-runner",
      propagateToApp: true,
      // 127.0.0.1 and localhost are the same server but different hostnames,
      // so one request is allowlisted and the other is not.
      propagateAllowlist: ["127.0.0.1"],
    };

    const run = startOtelRun(config, {
      runId: "run_abc",
      suiteName: "checkout",
      startedAt: new Date(),
      ci: NO_CI,
    });
    const scenario = run.startScenario({ name: "checkout > propagates" });

    browser = await chromium.launch();
    const context = await browser.newContext();
    await installTraceparentPropagation(context, {
      getContext: () => scenario.activeContext(),
      allowlist: config.propagateAllowlist,
    });
    const page = await context.newPage();

    const step = scenario.beginStep("browser_goto", {});
    const stepSpanContext = trace.getSpan(scenario.activeContext())!.spanContext();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.goto(`http://localhost:${port}/`);
    step.end();

    scenario.end({ status: "passed", reason: "ok", attempts: 1, durationMs: 10 });

    const allowed = seen.get("127.0.0.1");
    expect(allowed).toBeDefined();
    // Never sent to a host outside the allowlist.
    expect(seen.get("localhost")).toBeUndefined();

    // The header must reference the live *step* span. This is the whole
    // feature: it is what makes the app's own spans children of our step
    // rather than a detached trace sitting beside it.
    const [version, traceId, spanId, flags] = allowed!.split("-");
    expect(version).toBe("00");
    expect(traceId).toBe(stepSpanContext.traceId);
    expect(spanId).toBe(stepSpanContext.spanId);
    // Sampled, because runs are never sampled away.
    expect(flags).toBe("01");

    await context.close();
    await run.end({ status: "passed", finishedAt: new Date(), durationMs: 10 });
  }, 60_000);

  test("sends nothing when the allowlist is empty, even with propagation on", async () => {
    const seen: Array<string | undefined> = [];
    const server = await startFixtureServer([
      {
        path: "/",
        body: "<main>fixture</main>",
        onRequest: (request) => {
          seen.push(request.headers.traceparent as string | undefined);
        },
      },
    ]);
    closeServer = server.close;

    browser = await chromium.launch();
    const context = await browser.newContext();
    await installTraceparentPropagation(context, {
      getContext: () => undefined,
      allowlist: [],
    });
    const page = await context.newPage();
    await page.goto(server.url);

    expect(seen).toEqual([undefined]);
    await context.close();
  }, 60_000);

  test("falls the request through when context injection throws, so it never hangs", async () => {
    // A throwing getContext must not leave an intercepted request dangling.
    // The catch path best-effort calls route.fallback() so the page still loads.
    let loaded = false;
    const server = await startFixtureServer([
      {
        path: "/",
        body: "<main>fallback fixture</main>",
        onRequest: () => {},
      },
    ]);
    closeServer = server.close;
    const port = new URL(server.url).port;

    browser = await chromium.launch();
    const context = await browser.newContext();
    await installTraceparentPropagation(context, {
      // Throwing simulates a context that closed mid-flight or any internal
      // failure inside the OTel propagator.
      getContext: () => {
        throw new Error("injection failed");
      },
      allowlist: ["127.0.0.1"],
    });
    const page = await context.newPage();
    // The page must complete navigation rather than hanging on the intercept.
    await page.goto(`http://127.0.0.1:${port}/`, { timeout: 10_000 });
    loaded = true;
    await context.close();

    expect(loaded).toBe(true);
  }, 60_000);
});
