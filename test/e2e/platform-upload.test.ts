import { afterEach, describe, expect, test } from "bun:test";
import { uploadRunToPlatform } from "../../src/platform/upload";
import type { BlopRunResult, BlopTestResult } from "../../src/runtime/types";
import { startFixtureServer } from "../test-utils/server";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

type CapturedEvent = { type: string; data: Record<string, unknown> };

describe("platform upload", () => {
  test("emits CloudEvents started + finished with counts and top_failures", async () => {
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

    const result = await uploadRunToPlatform({
      ingestUrl: `${server.url}/api/ingest`,
      ingestSecret: "test-secret",
      projectId: "proj_123",
      result: createRunResult(),
      skipArtifacts: true,
    });

    expect(result.uploaded).toBe(true);
    expect(result.runId).toBe("run_platform_1");

    const types = events.map((e) => e.type);
    expect(types).toContain("qa.run.started.v1");
    expect(types).toContain("qa.run.finished.v1");

    const finished = events.find((e) => e.type === "qa.run.finished.v1")!;
    expect(finished.data.run_id).toBe("run_platform_1");
    expect(finished.data.project_id).toBe("proj_123");
    expect(finished.data.status).toBe("failed");
    expect(finished.data.counts).toEqual({ passed: 1, failed: 1, skipped: 0, flaky: 0 });
    expect(finished.data.top_failures).toEqual([{ test_file: "fails", message: "button not found" }]);
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

function makeTest(name: string, status: BlopTestResult["status"], reason: string): BlopTestResult {
  return {
    id: `t_${name}`,
    name,
    status,
    reason,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 500,
    attempts: 1,
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
  };
}