import { describe, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchLocalBrowser } from "../../src/node/browser-launcher.js";

describe("local browser launcher", () => {
  test("launches Camoufox with bounded benchmark-safe options", async () => {
    const expectedBrowser = {} as Browser;
    let received: Record<string, unknown> | undefined;

    const browser = await launchLocalBrowser(
      { browser: "camoufox", headed: true },
      {
        loadCamoufox: async () => ({
          async Camoufox(options) {
            received = options;
            return expectedBrowser;
          },
        }),
      },
    );

    expect(browser).toBe(expectedBrowser);
    const expectedOs = process.platform === "darwin"
      ? "macos"
      : process.platform === "win32" ? "windows" : "linux";
    expect(received).toEqual({
      headless: false,
      humanize: false,
      enable_cache: true,
      os: expectedOs,
      exclude_addons: ["UBO"],
    });
  });

  test("explains how to provision a missing Camoufox runtime", async () => {
    await expect(launchLocalBrowser(
      { browser: "camoufox" },
      { loadCamoufox: async () => { throw new Error("binary missing"); } },
    )).rejects.toThrow("pnpm exec camoufox-js fetch");
  });
});
