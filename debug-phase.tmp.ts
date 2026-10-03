import { chromium, type Browser } from "playwright";
import { createBrowserTools } from "@blopai/browser-harness";
import { startFixtureServer } from "./test/test-utils/server";

async function phase<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const warn = setTimeout(() => console.log(`  !! ${label} exceeded 5s`), 5000);
  try { return await fn(); } finally { clearTimeout(warn); const ms = Date.now() - started; if (ms > 500) console.log(`  ${label}: ${ms}ms`); }
}

for (let i = 0; i < 40; i++) {
  const server = await phase("server", () => startFixtureServer([{ path: "/", body: "<main><h1>Home</h1></main>" }]));
  const browser: Browser = await phase("launch", () => chromium.launch({ headless: true }));
  const context = await phase("context", () => browser.newContext());
  const page = await phase("page", () => context.newPage());
  const tools = await phase("tools", () => createBrowserTools({ page, testId: "t", screenshotDir: ".blop-test-screenshots", actions: [], screenshots: [], finishState: { status: null, reason: null } }));
  await phase("goto", () => tools.find(t => t.name === "browser_goto")!.execute({ url: server.url }));
  await phase("expect", () => tools.find(t => t.name === "browser_expect_text")!.execute({ text: "Home" }));
  await phase("close-browser", () => browser.close());
  await phase("close-server", () => server.close());
  console.log(`iter ${i} ok`);
}
