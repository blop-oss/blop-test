import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runBlopTests } from "../../src/runtime/runner";
import type { BlopAgentStreamRunner } from "../../src/runtime/types";
import { createTempDir, writeSpec } from "../test-utils/files";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("retry and timeout", () => {
  test("retries an agent error and records attempts", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const specFile = await writeSpec(temp.dir, "retry.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "retry smoke", goal: "Pass after retry." });
    `);
    let calls = 0;
    const agentStream: BlopAgentStreamRunner = async function* ({ nativeTools }) {
      calls += 1;
      if (calls === 1) throw new Error("transient agent failure");
      const tools = nativeTools as Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<unknown> }>;
      await tools.find((tool) => tool.name === "finish_test")?.execute({ status: "passed", reason: "Recovered." });
      yield { event_type: "done", metadata: null, content: null };
    };

    const result = await runBlopTests({ specFiles: [specFile], reportDir: join(temp.dir, ".blop"), retries: 1, agentStream });

    expect(result.status).toBe("passed");
    expect(result.results[0].attempts).toBe(2);
    expect(result.results[0].reason).toBe("Recovered.");
  });

  test("fails a run when the agent exceeds timeout", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const specFile = await writeSpec(temp.dir, "timeout.blop.ts", `
      import { defineAgentTest } from "${process.cwd()}/src/index.ts";
      export default defineAgentTest({ name: "timeout smoke", goal: "Never finish." });
    `);
    const agentStream: BlopAgentStreamRunner = async function* ({ signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal?.aborted) throw signal.reason;
      yield { event_type: "done", metadata: null, content: null };
    };

    const result = await runBlopTests({ specFiles: [specFile], reportDir: join(temp.dir, ".blop"), timeoutMs: 1, agentStream });

    expect(result.status).toBe("error");
    expect(result.results[0].reason).toContain("timed out");
  });
});
