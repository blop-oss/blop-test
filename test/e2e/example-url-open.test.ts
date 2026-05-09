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

describe("example url-open agent test", () => {
  test("agent opens a URL and verifies page content", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;

    const server = await startFixtureServer([
      {
        path: "/",
        body: `<html><body><main><h1>Example Domain</h1><p>Illustrative examples in documentation.</p></main></body></html>`,
      },
    ]);
    closeServer = server.close;

    const specFile = await writeSpec(temp.dir, "url-open.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({
        name: "opens example.com",
        goal: "Verify the page loaded and heading is visible. Pass if the heading 'Example Domain' is present.",
      });
    `);

    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<{
        name: string;
        execute: (input: Record<string, unknown>) => Promise<unknown>;
      }>;

      yield { event_type: "step_start", content: "Opening URL", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });

      yield { event_type: "step_start", content: "Checking heading", metadata: { tool: "browser_expect_text" } };
      await tool(tools, "browser_expect_text").execute({ text: "Example Domain" });

      yield { event_type: "step_start", content: "Checking paragraph", metadata: { tool: "browser_expect_text" } };
      await tool(tools, "browser_expect_text").execute({ text: "Illustrative examples" });

      yield { event_type: "step_start", content: "Finishing test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({ status: "passed", reason: "Page loaded and heading is visible." });

      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
    });

    expect(result.status).toBe("passed");
    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe("opens example.com");
    expect(result.results[0].status).toBe("passed");
    expect(result.results[0].reason).toBe("Page loaded and heading is visible.");
    expect(result.results[0].actions.map((a) => a.name)).toEqual([
      "browser_goto",
      "browser_expect_text",
      "browser_expect_text",
      "finish_test",
    ]);
  }, 15000);

  test("agent reads the page URL and page title", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;

    const server = await startFixtureServer([
      {
        path: "/",
        body: `<html><head><title>Test Page Title</title></head><body><h1>Hello World</h1></body></html>`,
      },
    ]);
    closeServer = server.close;

    const specFile = await writeSpec(temp.dir, "url-title.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({
        name: "reads url and title",
        goal: "Go to the page, verify the title is 'Test Page Title', and confirm the heading 'Hello World' is visible.",
      });
    `);

    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<{
        name: string;
        execute: (input: Record<string, unknown>) => Promise<unknown>;
      }>;

      yield { event_type: "step_start", content: "Opening URL", metadata: { tool: "browser_goto" } };
      const gotoResult = await tool(tools, "browser_goto").execute({ url: server.url });

      yield { event_type: "step_start", content: "Getting URL", metadata: { tool: "browser_get_url" } };
      const urlResult = await tool(tools, "browser_get_url").execute({});

      yield { event_type: "step_start", content: "Checking heading text", metadata: { tool: "browser_expect_text" } };
      await tool(tools, "browser_expect_text").execute({ text: "Hello World" });

      yield { event_type: "step_start", content: "Taking screenshot", metadata: { tool: "browser_screenshot" } };
      await tool(tools, "browser_screenshot").execute({});

      yield { event_type: "step_start", content: "Finishing test", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({
        status: "passed",
        reason: `URL opened: ${JSON.stringify(urlResult)}, page confirmed.`,
      });

      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
    });

    expect(result.status).toBe("passed");
    expect(result.results[0].actions.map((a) => a.name)).toEqual([
      "browser_goto",
      "browser_get_url",
      "browser_expect_text",
      "browser_screenshot",
      "finish_test",
    ]);
  }, 15000);

  test("agent reports failure when page does not contain expected text", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;

    const server = await startFixtureServer([
      {
        path: "/",
        body: `<html><body><h1>Wrong Page</h1></body></html>`,
      },
    ]);
    closeServer = server.close;

    const specFile = await writeSpec(temp.dir, "failing.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({
        name: "fails on missing text",
        goal: "Verify the page contains 'Expected Content'.",
      });
    `);

    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      const tools = nativeTools as Array<{
        name: string;
        execute: (input: Record<string, unknown>) => Promise<unknown>;
      }>;

      yield { event_type: "step_start", content: "Opening URL", metadata: { tool: "browser_goto" } };
      await tool(tools, "browser_goto").execute({ url: server.url });

      yield { event_type: "step_start", content: "Finishing as failed", metadata: { tool: "finish_test" } };
      await tool(tools, "finish_test").execute({
        status: "failed",
        reason: "Expected text 'Expected Content' was not found on the page.",
      });

      yield { event_type: "done", content: null, metadata: null };
    };

    const result = await runBlopTests({
      specFiles: [specFile],
      reportDir: join(temp.dir, ".blop"),
      agentStream,
      reporter: "all",
    });

    expect(result.status).toBe("failed");
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].reason).toBe("Expected text 'Expected Content' was not found on the page.");
  }, 15000);
});

function tool(
  tools: Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>,
  name: string
) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool: ${name}`);
  return found;
}
