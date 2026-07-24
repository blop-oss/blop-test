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

  test("publishes action screenshots to the live preview when CDP streaming is inactive", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<main><h1>Fallback preview fixture</h1></main>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "fallback-preview.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "fallback preview", goal: "Verify fixture." });
    `);
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      yield { event_type: "step_start", content: "finish_test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({ status: "passed", reason: "Preview captured." });
      yield { event_type: "done", content: null, metadata: null };
    };

    const reportDir = join(temp.dir, ".blop");
    const progressFile = join(temp.dir, "progress.ndjson");
    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir,
      progressFile,
      captureStepScreenshots: true,
      streamFrames: false,
      agentStream,
      reporter: "json",
    });

    expect(result.status).toBe("passed");
    const progress = (await readFile(progressFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const liveFramePath = join(reportDir, "screenshots", result.results[0].id, "live.jpg");
    expect(progress.some((entry) => entry.type === "frame" && entry.path === liveFramePath)).toBe(true);
    expect((await readFile(liveFramePath)).byteLength).toBeGreaterThan(0);
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

  test("runs multiple agent tests concurrently when workers is greater than one", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<main><h1>Parallel fixture</h1></main>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "parallel-agent.blop.ts", `
      import { agentTest } from "${process.cwd()}/src/index.ts";
      agentTest("parallel one", async ({ agent }) => {
        await agent.goto("/");
        await agent.goal("Verify the fixture.");
      });
      agentTest("parallel two", async ({ agent }) => {
        await agent.goto("/");
        await agent.goal("Verify the fixture.");
      });
    `);

    let active = 0;
    let maxActive = 0;
    let releaseFirstPair: (() => void) | undefined;
    const bothActive = new Promise<void>((resolve) => {
      releaseFirstPair = resolve;
    });
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) releaseFirstPair?.();
      await bothActive;
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      yield { event_type: "step_start", content: "finish_test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({ status: "passed", reason: "Parallel fixture verified." });
      active -= 1;
      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
      workers: 2,
    });

    expect(result.status).toBe("passed");
    expect(result.results.map((item) => item.name)).toEqual([
      "parallel one",
      "parallel two",
    ]);
    expect(maxActive).toBe(2);
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

  test("non-containerized runs assume internet egress and tell the agent to report third-party failures as real issues", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<main><h1>Mock agent fixture</h1></main>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "egress-on.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "egress on", goal: "Verify fixture." });
    `);
    const prompts: string[] = [];
    const agentStream: BlopAgentStreamRunner = async function* ({ prompt, nativeTools }) {
      prompts.push(String(prompt));
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      yield { event_type: "step_start", content: "finish_test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({ status: "passed", reason: "ok" });
      yield { event_type: "done", content: null, metadata: null };
    };

    await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      // Non-containerized: hasInternetEgress defaults to true.
      containerized: false,
    });

    expect(prompts.length).toBeGreaterThan(0);
    // With egress, a third-party failure is a real config issue, not a sandbox limit.
    expect(prompts[0]).toContain("the sandbox has confirmed internet egress");
    expect(prompts[0]).toContain("real issue the site owner should investigate");
    expect(prompts[0]).toContain("Stripe test card 4242 4242 4242 4242");
    // And it must NOT carry the no-egress caveat language.
    expect(prompts[0]).not.toContain("NO confirmed internet egress");
  });
});

function tool(tools: Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}
