import { startPlaywrightContainer } from "@blopai/browser-harness";

console.log("Starting container...");
const session = await startPlaywrightContainer();
console.log("Container started, browser connected!");
console.log("Testing page...");
const context = await session.browser.newContext();
const page = await context.newPage();
await page.goto("https://example.com");
const title = await page.title();
console.log("Page title:", title);
await context.close();
await session.stop();
console.log("Done!");
