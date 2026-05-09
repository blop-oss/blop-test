import { afterEach, describe, expect, test } from "bun:test";
import { loadBlopConfig } from "../../src/node/config";
import { createTempDir, writeSpec } from "../test-utils/files";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("config loading", () => {
  test("loads blop.config.ts from cwd", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    await writeSpec(temp.dir, "blop.config.ts", `
      export default {
        baseUrl: "http://127.0.0.1:3000",
        reporter: "json",
        browser: "chromium",
        viewport: { width: 390, height: 844 },
        retries: 2,
        timeoutMs: 5000,
        include: ["tests/**/*.blop.ts"]
      }
    `);

    const config = await loadBlopConfig(temp.dir);

    expect(config.baseUrl).toBe("http://127.0.0.1:3000");
    expect(config.reporter).toBe("json");
    expect(config.browser).toBe("chromium");
    expect(config.viewport).toEqual({ width: 390, height: 844 });
    expect(config.retries).toBe(2);
    expect(config.timeoutMs).toBe(5000);
    expect(config.include).toEqual(["tests/**/*.blop.ts"]);
  });

  test("returns empty config when no file exists", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;

    await expect(loadBlopConfig(temp.dir)).resolves.toEqual({});
  });
});
