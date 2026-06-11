import { chromium } from "playwright";

console.log("Connecting...");
const browser = await chromium.connectOverCDP("http://localhost:9223");
console.log("Connected!");
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://example.com");
const title = await page.title();
console.log("Page title:", title);
await context.close();
await browser.close();
console.log("Done!");
