import { afterEach, describe, expect, test } from "bun:test";
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

type Tool = { name: string; execute: (input: Record<string, unknown>) => Promise<unknown> };

function tool(tools: Array<Tool>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}

async function setup(name: string) {
  const temp = await createTempDir();
  cleanup = temp.cleanup;
  const server = await startFixtureServer([
    { path: "/", body: `<main><h1>Step limit fixture</h1></main>` },
  ]);
  closeServer = server.close;
  const specFile = await writeSpec(temp.dir, `${name}.blop.ts`, `
    import { defineAgentTest } from "${process.cwd()}/src/index.ts";
    export default defineAgentTest({ name: "${name}", goal: "Exercise step limits." });
  `);
  return { temp, server, specFile };
}

describe("runner step limits", () => {
  test("runs past the old 100-step default when no maxSteps is set", async () => {
    const { temp, server, specFile } = await setup("uncapped run");
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<Tool>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      // 110 distinct actions push the run well past the old hard cap of 100.
      for (let i = 0; i < 110; i += 1) {
        yield { event_type: "step_start", content: "record_critical_point", metadata: { tool: "record_critical_point" } };
        await tool(tools, "record_critical_point").execute({
          id: `cp-${i}`,
          description: `Checkpoint number ${i}`,
          status: "passed",
          evidence: `Evidence ${i}`,
        });
      }
      yield { event_type: "step_start", content: "finish_test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({ status: "passed", reason: "All checkpoints recorded." });
      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "json",
    });

    expect(result.status).toBe("passed");
    expect(result.results[0].actions.length).toBe(112);
  }, 60_000);

  test("aborts a run that loops without making progress", async () => {
    const { temp, server, specFile } = await setup("stalled run");
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools, signal }) {
      const tools = nativeTools as Array<Tool>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      // Identical assertion with an identical result, forever — the stall
      // guard must stop this before it loops indefinitely.
      for (let i = 0; i < 50; i += 1) {
        if (signal?.aborted) return;
        yield { event_type: "step_start", content: "browser_expect_text", metadata: { tool: "browser_expect_text" } };
        await tool(tools, "browser_expect_text").execute({ text: "Step limit fixture" });
      }
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "json",
    });

    expect(result.status).toBe("error");
    expect(result.results[0].reason).toContain("stuck");
    // The guard tripped long before the mock's 50 iterations ran out.
    expect(result.results[0].actions.length).toBeLessThan(20);
  }, 60_000);

  test("aborts a repeated action cycle despite volatile snapshot text", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      {
        path: "/",
        body: `<main>
          <label>Search <input aria-label="Search" /></label>
          <button onclick="document.querySelector('#counter').textContent = String(Date.now())">Search</button>
          <span id="counter">0</span>
        </main>`,
      },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "volatile-cycle.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "volatile cycle", goal: "Exercise cycle detection." });
    `);
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools, signal }) {
      const tools = nativeTools as Array<Tool>;
      await tool(tools, "browser_goto").execute({ url: server.url });
      for (let index = 0; index < 30; index += 1) {
        if (signal?.aborted) return;
        await tool(tools, "browser_type").execute({ target: { label: "Search" }, text: "Seattle" });
        await tool(tools, "browser_click").execute({ target: { role: "button", name: "Search" } });
        await tool(tools, "browser_snapshot").execute({});
        yield { event_type: "step_start", content: "cycle", metadata: { tool: "browser_snapshot" } };
      }
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "json",
    });

    expect(result.status).toBe("error");
    expect(result.results[0].reason).toContain("short browser-action cycle repeated");
    expect(result.results[0].actions.length).toBeLessThan(30);
  }, 60_000);

  test("aborts a repeated cycle with opaque snapshot references", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      {
        path: "/",
        body: `<main>
          <div tabindex="0" onclick="document.querySelector('#counter').textContent = String(Date.now())">Search</div>
          <span id="counter">0</span>
        </main>`,
      },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "reference-cycle.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "reference cycle", goal: "Exercise reference cycle detection." });
    `);
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools, signal }) {
      const tools = nativeTools as Array<Tool>;
      await tool(tools, "browser_goto").execute({ url: server.url });
      for (let index = 0; index < 30; index += 1) {
        if (signal?.aborted) return;
        const snapshot = await tool(tools, "browser_snapshot").execute({});
        const semanticSnapshot = JSON.parse(snapshot.content).semanticSnapshot as string;
        const ref = semanticSnapshot.match(/\[(x\d+)\] interactive "Search"/)?.[1];
        if (!ref) throw new Error("Search reference missing from snapshot.");
        await tool(tools, "browser_click").execute({ target: { ref } });
        yield { event_type: "step_start", content: "cycle", metadata: { tool: "browser_click" } };
      }
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "json",
    });

    expect(result.status).toBe("error");
    expect(result.results[0].reason).toContain("short browser-action cycle repeated");
    expect(result.results[0].actions.length).toBeLessThan(20);
  }, 60_000);

  test("does not normalize ref-shaped text outside a ref field", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const server = await startFixtureServer([
      { path: "/", body: `<label>Code <input aria-label="Code" /></label>` },
    ]);
    closeServer = server.close;
    const specFile = await writeSpec(temp.dir, "ref-shaped-text.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "ref-shaped text", goal: "Exercise reference normalization scope." });
    `);
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<Tool>;
      await tool(tools, "browser_goto").execute({ url: server.url });
      for (let index = 0; index < 8; index += 1) {
        await tool(tools, "browser_type").execute({ target: { label: "Code" }, text: `x${index}` });
        yield { event_type: "step_start", content: "type", metadata: { tool: "browser_type" } };
      }
      await tool(tools, "finish_test").execute({ status: "passed", reason: "Distinct values remained distinct." });
      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "json",
    });

    expect(result.status).toBe("passed");
  }, 60_000);

  test("still enforces an explicit maxSteps cap", async () => {
    const { temp, server, specFile } = await setup("capped run");
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools, signal }) {
      const tools = nativeTools as Array<Tool>;
      yield { event_type: "step_start", content: "browser_goto", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });
      for (let i = 0; i < 10; i += 1) {
        if (signal?.aborted) return;
        yield { event_type: "step_start", content: "record_critical_point", metadata: { tool: "record_critical_point" } };
        await tool(tools, "record_critical_point").execute({
          id: `cp-${i}`,
          description: `Checkpoint number ${i}`,
          status: "passed",
        });
      }
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      maxSteps: 3,
      reporter: "json",
    });

    expect(result.status).toBe("error");
    expect(result.results[0].reason).toContain("exceeded max step count of 3");
  }, 60_000);
});
