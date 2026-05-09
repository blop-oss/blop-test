import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runBlopTests } from "../../src/runtime/runner";
import type { BlopAgentStreamRunner } from "../../src/runtime/types";
import { createTempDir, writeSpec } from "../test-utils/files";
import { startFixtureServer } from "../test-utils/server";

let cleanup: (() => Promise<void>) | undefined;
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  await cleanup?.();
  closeServer = undefined;
  cleanup = undefined;
});

describe("runner with mock agent", () => {
  test("runs a full browser-backed agent test without calling a model", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<main><h1>Mock agent fixture</h1></main>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "mock-agent.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "mock agent smoke", goal: "Verify fixture." });
    `);
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      yield { event_type: "step_start", content: "browser_expect_text", metadata: { tool: "browser_expect_text" } };
      await tool(tools, "browser_expect_text").execute({ text: "Mock agent fixture" });
      yield { event_type: "step_start", content: "finish_test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({ status: "passed", reason: "Fixture text was visible." });
      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
    });

    expect(result.status).toBe("passed");
    expect(result.results[0].reason).toBe("Fixture text was visible.");
    expect(result.results[0].actions.map((action) => action.name)).toEqual([
      "browser_goto",
      "browser_expect_text",
      "finish_test",
    ]);
    const report = JSON.parse(await readFile(join(temp.dir, ".blop", "results.json"), "utf8"));
    expect(report.results[0].status).toBe("passed");
  });
});

function tool(tools: Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}
