import { chromium, firefox, webkit, type Browser } from "playwright";
import type { BlopBrowserName } from "../runtime/types.js";

type CamoufoxModule = {
  Camoufox(options: {
    headless: boolean;
    humanize: boolean;
    enable_cache: boolean;
    exclude_addons: ["UBO"];
    os: "linux" | "macos" | "windows";
  }): Promise<unknown>;
};

type BrowserLauncherDependencies = {
  loadCamoufox?: () => Promise<CamoufoxModule>;
};

export async function launchLocalBrowser(
  options: { browser?: BlopBrowserName; headed?: boolean },
  dependencies: BrowserLauncherDependencies = {},
): Promise<Browser> {
  const browserName = options.browser ?? "chromium";
  if (browserName !== "camoufox") {
    return { chromium, firefox, webkit }[browserName].launch({
      headless: !options.headed,
    });
  }

  try {
    const loadCamoufox = dependencies.loadCamoufox
      ?? (() => import("camoufox-js") as Promise<CamoufoxModule>);
    const { Camoufox } = await loadCamoufox();
    const os = process.platform === "darwin"
      ? "macos"
      : process.platform === "win32" ? "windows" : "linux";
    const browser = await Camoufox({
      headless: !options.headed,
      humanize: false,
      enable_cache: true,
      os,
      // The Chromium control has no ad blocker. Keep page content comparable
      // instead of letting Camoufox's default uBlock addon change the task.
      exclude_addons: ["UBO"],
    });
    return browser as Browser;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to launch Camoufox: ${message}\n\n` +
      "Camoufox requires Node.js 22 or newer and a downloaded browser binary. " +
      "Install `camoufox-js@0.11.1` and `playwright-core@1.61.1`, then run " +
      "`pnpm exec camoufox-js fetch`.",
    );
  }
}
