import { afterEach, describe, expect, test } from "bun:test";
import { uploadRunToPlatform } from "../../src/platform/upload";
import type { BlopRunResult, BlopTestResult } from "../../src/runtime/types";
import { startFixtureServer } from "../test-utils/server";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

type CapturedEvent = {
  type: string;
  traceparent?: string;
  tracestate?: string;
  data: Record<string, unknown>;
};

describe("platform upload", () => {
  test("emits CloudEvents started + finished with counts and top_failures", async () => {
    const events: CapturedEvent[] = [];
    const server = await startFixtureServer([
      {
        path: "/api/ingest",
        body: "{}",
        onRequest: (_request, body) => {
          const event = JSON.parse(body);
          events.push({
            type: event.type,
            traceparent: event.traceparent,
            tracestate: event.tracestate,
            data: event.data,
          });
        },
      },
      { path: "/api/ingest/artifact-upload-url", body: "R2 off", contentType: "text/plain" },
    ]);
    closeServer = server.close;

    const result = await uploadRunToPlatform({
      ingestUrl: `${server.url}/api/ingest`,
      ingestSecret: "test-secret",
      projectId: "proj_123",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
      result: createRunResult(),
      skipArtifacts: true,
    });

    expect(result.uploaded).toBe(true);
    expect(result.runId).toBe("run_platform_1");

    const types = events.map((e) => e.type);
    expect(types).toContain("qa.run.started.v1");
    expect(types).toContain("qa.run.finished.v1");

    const finished = events.find((e) => e.type === "qa.run.finished.v1")!;
    expect(finished.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(finished.tracestate).toBe("vendor=value");
    expect(finished.data.run_id).toBe("run_platform_1");
    expect(finished.data.project_id).toBe("proj_123");
    expect(finished.data.status).toBe("failed");
    expect(finished.data.counts).toEqual({ passed: 1, failed: 1, skipped: 0, flaky: 0 });
    expect(finished.data.top_failures).toEqual([{ test_file: "fails", message: "button not found" }]);
  });

  test("attaches bounded failure evidence to top_failures, never raw payloads", async () => {
    const events: CapturedEvent[] = [];
    const server = await startFixtureServer([
      {
        path: "/api/ingest",
        body: "{}",
        onRequest: (_request, body) => {
          const event = JSON.parse(body);
          events.push({ type: event.type, data: event.data });
        },
      },
      { path: "/api/ingest/artifact-upload-url", body: "R2 off", contentType: "text/plain" },
    ]);
    closeServer = server.close;

    const failing = makeTest("checkout", "failed", "assertion failed", {
      baseUrl: "https://app.example.com",
      browserLogs: [
        {
          type: "pageerror",
          message: "Cannot read properties of undefined (reading 'total')",
          url: "https://app.example.com/cart",
          timestamp: "2026-01-01T00:00:00.500Z",
          level: "attempt:1",
        },
      ],
      actions: [
        {
          name: "browser_expect_text",
          input: { target: "#total" },
          output: "",
          metadata: { error: "expected \"$40\" to be visible" },
          timestamp: "2026-01-01T00:00:00.400Z",
          durationMs: 200,
        },
      ],
    });

    await uploadRunToPlatform({
      ingestUrl: `${server.url}/api/ingest`,
      ingestSecret: "test-secret",
      projectId: "proj_123",
      result: {
        runId: "run_platform_evidence",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        results: [failing],
      },
      skipArtifacts: true,
    });

    const finished = events.find((e) => e.type === "qa.run.finished.v1")!;
    const failure = (finished.data.top_failures as Array<Record<string, unknown>>)[0];
    expect(failure.failing_tool).toBe("browser_expect_text");
    expect(failure.signals).toContain("page_error");
    expect(failure.signals).toContain("assertion_mismatch");
    // The whole point of the closed vocabulary: the console text, the DOM and
    // the request URL that produced those signals never leave the runner.
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("Cannot read properties");
    expect(serialized).not.toContain("app.example.com");
  });

  test("sends per-test rows keyed on the spec file, skipping synthetic records", async () => {
    const events: CapturedEvent[] = [];
    const server = await startFixtureServer([
      {
        path: "/api/ingest",
        body: "{}",
        onRequest: (_request, body) => {
          const event = JSON.parse(body);
          events.push({ type: event.type, data: event.data });
        },
      },
    ]);
    closeServer = server.close;

    await uploadRunToPlatform({
      ingestUrl: `${server.url}/api/ingest`,
      ingestSecret: "test-secret",
      projectId: "proj_123",
      skipArtifacts: true,
      result: {
        runId: "run_platform_2",
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        results: [
          makeTest("checkout > guest can buy", "passed", "", { durationMs: 1200 }),
          makeTest("checkout > card is charged", "failed", "button not found", {
            durationMs: 900,
            attempts: 2,
          }),
          makeTest("(run error)", "error", "boom", { specFile: null, synthetic: true }),
        ],
      },
    });

    const finished = events.find((e) => e.type === "qa.run.finished.v1")!;
    const tests = finished.data.tests as Array<Record<string, unknown>>;
    expect(tests).toHaveLength(2);
    expect(tests[0]).toEqual({
      suite: "blop",
      classname: "e2e/checkout.blop.ts",
      name: "checkout > guest can buy",
      status: "passed",
      duration_ms: 1200,
    });
    expect(tests[1]).toMatchObject({ attempts: 2, message: "button not found" });

    // counts and top_failures keep their existing, deliberately different keys:
    // top_failures[].test_file is the test NAME for blop runs, and changing it
    // would fork every triage_clusters signature.
    expect(finished.data.counts).toEqual({ passed: 1, failed: 2, skipped: 0, flaky: 0 });
    expect((finished.data.top_failures as Array<Record<string, unknown>>)[0].test_file).toBe(
      "checkout > card is charged"
    );
  });

  test("a scenario that went green on a retry is uploaded as flaky, not as a plain pass", async () => {
    const events: CapturedEvent[] = [];
    const server = await startFixtureServer([
      {
        path: "/api/ingest",
        body: "{}",
        onRequest: (_request, body) => {
          const event = JSON.parse(body);
          events.push({ type: event.type, data: event.data });
        },
      },
    ]);
    closeServer = server.close;

    await uploadRunToPlatform({
      ingestUrl: `${server.url}/api/ingest`,
      ingestSecret: "test-secret",
      projectId: "proj_123",
      skipArtifacts: true,
      result: {
        runId: "run_platform_flaky",
        status: "passed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        results: [
          makeTest("checkout", "passed", "", { attempts: 2, firstAttemptStatus: "failed", resumes: 0 }),
          makeTest("login", "passed", "", { attempts: 1, firstAttemptStatus: null, resumes: 2 }),
        ],
      },
    });

    const finished = events.find((e) => e.type === "qa.run.finished.v1")!;
    // One flake. The two agent resumes on `login` are not retries.
    expect(finished.data.counts).toEqual({ passed: 2, failed: 0, skipped: 0, flaky: 1 });

    const tests = finished.data.tests as Array<Record<string, unknown>>;
    const checkout = tests.find((t) => t.name === "checkout")!;
    expect(checkout.attempts).toBe(2);
    expect(checkout.first_status).toBe("failed");
    expect(checkout.resumes).toBeUndefined();

    const login = tests.find((t) => t.name === "login")!;
    expect(login.attempts).toBeUndefined();
    expect(login.first_status).toBeUndefined();
    expect(login.resumes).toBe(2);
  });

  test("skips upload when platform is not configured", async () => {
    await expect(uploadRunToPlatform({ result: createRunResult() })).resolves.toEqual({
      uploaded: false,
      reason: "platform_not_configured",
    });
  });
});

function createRunResult(): BlopRunResult {
  return {
    runId: "run_platform_1",
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    results: [
      makeTest("passes", "passed", ""),
      makeTest("fails", "failed", "button not found"),
    ],
  };
}

function makeTest(
  name: string,
  status: BlopTestResult["status"],
  reason: string,
  overrides: Partial<BlopTestResult> = {}
): BlopTestResult {
  return {
    id: `t_${name}`,
    name,
    status,
    reason,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 500,
    attempts: 1,
    firstAttemptStatus: null,
    resumes: 0,
    baseUrl: null,
    provider: null,
    model: null,
    ci: { provider: null, runId: null, jobId: null, branch: null, commitSha: null, pullRequest: null },
    screenshots: [],
    screenshotArtifacts: [],
    criticalPoints: [],
    browserLogs: [],
    actions: [],
    events: [],
    specFile: "e2e/checkout.blop.ts",
    ...overrides,
  };
}
