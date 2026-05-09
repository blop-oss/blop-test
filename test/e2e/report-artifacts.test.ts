import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeReports } from "../../src/reporters";
import type { BlopRunResult } from "../../src/runtime/types";
import { createTempDir } from "../test-utils/files";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("report artifacts", () => {
  test("writes JSON, event log, and JUnit-compatible output", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const result = createRunResult();

    await writeReports(temp.dir, result, "all");

    const resultsJson = JSON.parse(await readFile(join(temp.dir, "results.json"), "utf8")) as BlopRunResult;
    const eventsJsonl = await readFile(join(temp.dir, "events.jsonl"), "utf8");
    const junit = await readFile(join(temp.dir, "report.xml"), "utf8");

    expect(resultsJson.runId).toBe("run_report_1");
    expect(resultsJson.results[0].screenshots).toEqual(["screenshots/test_1/success.png"]);
    expect(eventsJsonl.trim().split("\n")).toHaveLength(2);
    expect(eventsJsonl).toContain("browser_get_url");
    expect(junit).toContain('<testsuite name="blop" tests="1" failures="0"');
    expect(junit).toContain('<testcase classname="blop" name="checkout &gt; guest can buy"');
  });

  test("json reporter skips JUnit artifact but keeps machine-readable agent events", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;

    await writeReports(temp.dir, createRunResult(), "json");

    const eventsJsonl = await readFile(join(temp.dir, "events.jsonl"), "utf8");
    const junit = await readFile(join(temp.dir, "report.xml"), "utf8").catch(() => null);

    expect(eventsJsonl).toContain("text_delta");
    expect(junit).toBeNull();
  });
});

function createRunResult(): BlopRunResult {
  return {
    runId: "run_report_1",
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    durationMs: 2000,
    results: [
      {
        id: "test_1",
        name: "checkout > guest can buy",
        status: "passed",
        reason: "The agent completed checkout and verified confirmation.",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:02.000Z",
        durationMs: 2000,
        baseUrl: "http://127.0.0.1:3000",
        provider: "test-provider",
        model: "test-model",
        ci: {
          provider: null,
          runId: null,
          jobId: null,
          branch: null,
          commitSha: null,
          pullRequest: null,
        },
        screenshots: ["screenshots/test_1/success.png"],
        actions: [
          {
            name: "browser_get_url",
            input: {},
            output: "http://127.0.0.1:3000/checkout",
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        ],
        events: [
          {
            event_type: "step_start",
            content: "browser_get_url",
            metadata: { tool: "browser_get_url" },
            timestamp: "2026-01-01T00:00:01.000Z",
          },
          {
            event_type: "text_delta",
            content: "Checkout verified.",
            metadata: null,
            timestamp: "2026-01-01T00:00:02.000Z",
          },
        ],
      },
    ],
  };
}
