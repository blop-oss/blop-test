// LLM-free measuring stick for the streaming path. Drives the REAL runner with
// a mock agent stream (no model calls) against a locally-served animated page,
// then reports frame throughput + per-action screenshot overhead from the
// progress NDJSON the host (web-sk) consumes.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { runBlopTests } from "../src/runtime/runner.ts";
import type { BlopAgentStreamRunner } from "../src/runtime/types.ts";

const HTML = `<!doctype html><html><head><style>
  @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
  .box { width:120px;height:120px;background:#3b82f6;animation:spin 1s linear infinite;margin:40px }
  body { font-family: sans-serif }
</style></head><body><h1>Animated fixture</h1><div class="box"></div>
<button id="go">Go</button></body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(HTML);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const addr = server.address();
const baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

// Mock agent: navigate, snapshot, click, snapshot, finish — calling the real
// browser tools, with a short think-pause between steps so the animated page
// keeps repainting and the screencast keeps streaming, exactly like a slow LLM.
const mockAgent: BlopAgentStreamRunner = async function* ({ nativeTools }) {
  const tools = nativeTools as Array<{ name: string; execute: (i: any) => Promise<any> }>;
  const call = (n: string, i: any = {}) => tools.find((t) => t.name === n)!.execute(i);
  const think = () => new Promise((r) => setTimeout(r, 600));
  yield { event_type: "step_start", content: null };
  await call("browser_goto", { url: baseUrl }); await think();
  await call("browser_snapshot", {}); await think();
  await call("browser_click", { target: "#go" }); await think();
  await call("browser_snapshot", {}); await think();
  await call("finish_test", { status: "passed", reason: "done" });
  yield { event_type: "done", content: null };
};

const progressFile = "bench/progress-streame2e.ndjson";
const t0 = performance.now();
await runBlopTests({
  specFiles: ["bench/single.blop.ts"],
  baseUrl,
  reportDir: "bench/report-streame2e",
  progressFile,
  captureStepScreenshots: true,
  reporter: "json",
  agentStream: mockAgent,
  frameIntervalMs: 100,
});
const wall = (performance.now() - t0) / 1000;
await new Promise<void>((r) => server.close(() => r()));

const lines = readFileSync(progressFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const frames = lines.filter((e) => e.type === "frame");
const actions = lines.filter((e) => e.type === "action");
const withShot = actions.filter((a) => a.screenshotPath).length;
console.log(`wall_seconds       = ${wall.toFixed(2)}`);
console.log(`actions            = ${actions.length}  (step screenshots: ${withShot}/${actions.length})`);
console.log(`frames streamed    = ${frames.length}`);
console.log(`frame throughput   = ${(frames.length / wall).toFixed(1)} frames/sec to host`);
console.log(`first frame seq    = ${frames[0]?.seq}, last = ${frames.at(-1)?.seq}`);
