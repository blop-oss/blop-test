import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stopPlaywrightContainer } from "../../src/node/playwright-container";
import { runBlopTests } from "../../src/runtime/runner";
import type { BlopAgentStreamRunner } from "../../src/runtime/types";
import { createTempDir, writeSpec } from "../test-utils/files";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
const TEST_CONTAINER = "blop-playwright-test-runner";

afterAll(async () => {
  if (hasDocker) await stopPlaywrightContainer(TEST_CONTAINER);
});

describe.skipIf(!hasDocker)("containerized runner", () => {
  test(
    "runs a full mock-agent test against the shared container, with live frames",
    async () => {
      const temp = await createTempDir();
      const specFile = await writeSpec(temp.dir, "containerized.blop.ts", `
        import { defineAgentTest } from "${process.cwd()}/src/index.ts";
        export default defineAgentTest({ name: "containerized smoke", goal: "Verify sandboxed page." });
      `);
      const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
        const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
        const tool = (name: string) => {
          const found = tools.find((candidate) => candidate.name === name);
          if (!found) throw new Error(`Missing tool: ${name}`);
          return found;
        };
        yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
        await tool("browser_goto").execute({ url: "data:text/html,<title>sandboxed</title><h1>Containerized fixture</h1>" });
        yield { event_type: "step_start", content: "browser_expect_text", metadata: { tool: "browser_expect_text" } };
        await tool("browser_expect_text").execute({ text: "Containerized fixture" });
        yield { event_type: "step_start", content: "finish_test", metadata: { tool: "finish_test" } };
        await tool("finish_test").execute({ status: "passed", reason: "Sandboxed page rendered." });
        yield { event_type: "done", content: null, metadata: null };
      };

      const progressFile = join(temp.dir, "progress.ndjson");
      const result = await runBlopTests({
        specFiles: [specFile],
        reportDir: join(temp.dir, ".blop"),
        agentStream,
        reporter: "json",
        containerized: { containerName: TEST_CONTAINER },
        progressFile,
        captureStepScreenshots: true,
      });

      expect(result.status).toBe("passed");
      expect(result.results[0].reason).toBe("Sandboxed page rendered.");
      expect(result.results[0].actions.map((action) => action.name)).toEqual([
        "browser_goto",
        "browser_expect_text",
        "finish_test",
      ]);

      // The live progress stream (and its CDP screencast) must work against
      // the remote containerized browser exactly like a local one.
      const progressLines = (await readFile(progressFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      const types = new Set(progressLines.map((line) => line.type));
      expect(types.has("test_start")).toBe(true);
      expect(types.has("action")).toBe(true);
      expect(types.has("test_finish")).toBe(true);

      const report = JSON.parse(await readFile(join(temp.dir, ".blop", "results.json"), "utf8"));
      expect(report.results[0].status).toBe("passed");

      await temp.cleanup();
    },
    240_000,
  );
});
