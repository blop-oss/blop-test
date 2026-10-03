// No-LLM micro-benchmark isolating the per-action screenshot overhead:
//   (A) current approach: blocking page.screenshot({type:jpeg,quality:45})
//   (B) streamed approach: CDP screencast keeps latest frame in memory; we
//       just write that buffer. Measures the latency each browser action pays.
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = 25;
const out = tmpdir();

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto("https://example.com", { waitUntil: "domcontentloaded" });

// (A) blocking screenshot per action
let aTotal = 0;
for (let i = 0; i < N; i++) {
  const t = performance.now();
  await page.screenshot({ path: join(out, `a-${i}.jpg`), type: "jpeg", quality: 45 });
  aTotal += performance.now() - t;
}

// (B) screencast: latest frame held in memory, write the buffer
const client = await ctx.newCDPSession(page);
let latest: Buffer | null = null;
let frames = 0;
client.on("Page.screencastFrame", (p: any) => {
  client.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  latest = Buffer.from(p.data, "base64");
  frames++;
});
await client.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
// nudge a repaint so we get at least one frame, then wait briefly
await page.mouse.move(10, 10);
await page.waitForTimeout(400);

let bTotal = 0;
for (let i = 0; i < N; i++) {
  const t = performance.now();
  if (latest) await writeFile(join(out, `b-${i}.jpg`), latest);
  bTotal += performance.now() - t;
}
await client.send("Page.stopScreencast").catch(() => {});

console.log(`(A) blocking page.screenshot  avg = ${(aTotal / N).toFixed(1)} ms/action`);
console.log(`(B) screencast frame write    avg = ${(bTotal / N).toFixed(1)} ms/action`);
console.log(`screencast frames received in 400ms idle window: ${frames}`);
console.log(`per-action overhead removed   ≈ ${((aTotal - bTotal) / N).toFixed(1)} ms/action`);

await browser.close();
