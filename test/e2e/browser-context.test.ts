import { describe, expect, test } from "bun:test";
import {
  browserSupportsCdpScreencast,
  resolveBrowserContextOptions,
} from "../../src/runtime/runner.js";

describe("browser context options", () => {
  test("disables Playwright viewport emulation for Camoufox", () => {
    expect(resolveBrowserContextOptions({
      browser: "camoufox",
      viewport: { width: 390, height: 844 },
      browserContext: { viewport: { width: 1280, height: 720 } },
    })).toEqual({
      viewport: null,
      bypassCSP: true,
    });
  });

  test("preserves viewport options for Playwright browser backends", () => {
    expect(resolveBrowserContextOptions({
      browser: "chromium",
      viewport: { width: 390, height: 844 },
      browserContext: {
        viewport: { width: 1280, height: 720 },
        locale: "da-DK",
        bypassCSP: false,
      },
    })).toEqual({
      viewport: { width: 390, height: 844 },
      locale: "da-DK",
      bypassCSP: true,
    });
  });

  test("does not enable Chromium CDP streaming for containerized Camoufox", () => {
    expect(browserSupportsCdpScreencast({
      browser: "camoufox",
      containerized: true,
    })).toBe(false);
    expect(browserSupportsCdpScreencast({
      browser: "chromium",
      containerized: true,
    })).toBe(true);
  });
});
