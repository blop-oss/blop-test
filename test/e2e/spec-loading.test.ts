import { afterEach, describe, expect, test } from "bun:test";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentTests } from "../../src/runtime/spec";
import { createTempDir, writeSpec } from "../test-utils/files";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sourceImport = JSON.stringify(`${packageRoot}/src/index.ts`);
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("agent spec loading", () => {
  test("loads registered describe/agentTest specs", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const specFile = await writeSpec(temp.dir, "signup.blop.ts", `
      import { agentTest, describe } from ${sourceImport};

      describe("signup", () => {
        agentTest("creates an account", async ({ agent }) => {
          await agent.goto("/");
          await agent.goal("Create an account and verify the dashboard is visible.");
        });
      });
    `);

    const tests = await loadAgentTests(specFile);

    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe("signup > creates an account");
    expect(tests[0].goal).toContain("Open /");
    expect(tests[0].goal).toContain("Create an account");
  });

  test("loads object-form generated specs", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const specFile = await writeSpec(temp.dir, "generated.blop.ts", `
      import { defineAgentTest } from ${sourceImport};

      export default defineAgentTest({
        name: "generated smoke",
        goal: "Verify the homepage renders."
      });
    `);

    const tests = await loadAgentTests(specFile);

    expect(tests).toEqual([
      {
        name: "generated smoke",
        goal: "Verify the homepage renders.",
      },
    ]);
  });

  test("keeps relative test paths usable in output", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const specFile = await writeSpec(temp.dir, "path.blop.ts", `
      import { defineAgentTest } from ${sourceImport};
      export default defineAgentTest({ name: "path smoke", goal: "Verify path handling." });
    `);

    expect(relative(temp.dir, specFile)).toBe("path.blop.ts");
  });
});
