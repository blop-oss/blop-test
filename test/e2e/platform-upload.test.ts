import { afterEach, describe, expect, test } from "bun:test";
import { uploadRunToPlatform } from "../../src/platform/upload";
import type { BlopRunResult } from "../../src/runtime/types";
import { startFixtureServer } from "../test-utils/server";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("platform upload", () => {
  test("posts run result to Blop Platform ingest endpoint", async () => {
    let authorization = "";
    let receivedRunId = "";
    const server = await startFixtureServer([
      {
        method: "POST",
        path: "/api/runs/ingest",
        body: JSON.stringify({ ok: true }),
        contentType: "application/json",
        onRequest(request, body) {
          authorization = request.headers.authorization ?? "";
          receivedRunId = JSON.parse(body).runId;
        },
      },
    ]);
    closeServer = server.close;

    const result = await uploadRunToPlatform({
      platformUrl: server.url,
      apiKey: "test-key",
      result: createRunResult(),
    });

    expect(result).toEqual({ uploaded: true });
    expect(authorization).toBe("Bearer test-key");
    expect(receivedRunId).toBe("run_platform_1");
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
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    results: [],
  };
}
