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

  test("classifies a stream that errors and dies mid-test as a runtime error, not an app failure", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<main><h1>Mock agent fixture</h1></main>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "dying-agent.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "agent stream dies", goal: "Verify fixture." });
    `);
    // Mirrors a real failure: the agent makes one browser call, then the
    // provider rejects every retry (e.g. malformed tool-call JSON poisoned the
    // history) and the stream ends without finish_test.
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      yield { event_type: "error", content: "LLM error (retry 3/3): HTTP 400 Bad Request", metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
    });

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].reason).toContain("stopped after 1 action(s) without calling finish_test");
    expect(result.results[0].reason).toContain("LLM error (retry 3/3): HTTP 400 Bad Request");
  });
  test("resumes an agent session that ends mid-test without finish_test", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<main><h1>Mock agent fixture</h1></main>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "stalling-agent.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "agent stalls mid-test", goal: "Verify fixture." });
    `);
    // Mirrors a real small-model failure: the first session ends a turn with
    // planning prose and no tool call (which ends the agent session), so the
    // runner must resume on the still-open browser instead of failing.
    const prompts: string[] = [];
    const agentStream: BlopAgentStreamRunner = async function* ({ prompt, nativeTools }) {
      prompts.push(String(prompt));
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      if (prompts.length === 1) {
        yield { event_type: "llm_call_start", content: null, metadata: null };
        yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
        await tool(tools, "browser_goto").execute({ url: server.url });
        yield { event_type: "text_delta", content: "Let me continue exploring the page.", metadata: null };
        yield { event_type: "done", content: null, metadata: null };
        return;
      }
      yield { event_type: "llm_call_start", content: null, metadata: null };
      yield { event_type: "step_start", content: "finish_test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({ status: "passed", reason: "Fixture verified after resume." });
      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
    });

    expect(result.results[0].status).toBe("passed");
    expect(result.results[0].reason).toBe("Fixture verified after resume.");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("resuming an agentic browser E2E test");
    expect(prompts[1]).toContain("browser_goto");
    expect(prompts[1]).toContain("end by calling finish_test");
  });

  test("classifies a final turn that writes tool calls as text as a runtime error, not an app failure", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<main><h1>Mock agent fixture</h1></main>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "mangled-agent.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "agent mangles tool calls", goal: "Verify fixture." });
    `);
    // Mirrors a real small-model failure: after working tool calls, the model
    // drifts out of the tool-calling format and serializes its remaining calls
    // (including finish_test) as text, which the runtime discards; the stream
    // then ends gracefully without finish_test.
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      yield { event_type: "llm_call_start", content: null, metadata: null };
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      yield { event_type: "llm_call_start", content: null, metadata: null };
      yield {
        event_type: "text_delta",
        content: '<|tool_call>call:finish_test{status:<|"|>passed<|"|>,reason:<|"|>Looks fine.<|"|>}<tool_call|>',
        metadata: null,
      };
      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
    });

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].reason).toContain("wrote tool calls as plain text");
    expect(result.results[0].reason).toContain("not a result for the app under test");
  });
});

function tool(tools: Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}
