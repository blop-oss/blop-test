import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeToolBridge } from "@blopai/browser-harness";
import { BrowserCoverageCollector, coverageLineState, coverageTotals, validateTestCoverageReport } from "../../src/coverage";
import { runBlopTests } from "../../src/runtime/runner";
import { createTempDir, writeSpec } from "../test-utils/files";

const report = () => ({
  schemaVersion: 1, runId: "coverage-run", browser: "chromium",
  startedAt: "2026-10-03T10:00:00.000Z", finishedAt: "2026-10-03T10:00:01.000Z",
  tests: [{ id: "test-1", name: "checkout", status: "passed" }],
  files: [{ url: "https://app.test/app.js", source: "abcdef", ranges: [{ start: 0, end: 2 }], testIds: ["test-1"] }], warnings: [],
});

describe("JavaScript coverage", () => {
  test("unions executions across tests without counting the same source twice, keeping changed script versions separate", () => {
    const collector = new BrowserCoverageCollector();
    collector.add([{ url: "https://app.test/app.js", source: "abcdef", functions: [{ ranges: [{ startOffset: 0, endOffset: 2, count: 1 }] }] }], "test-1");
    collector.add([{ url: "https://app.test/app.js", source: "abcdef", functions: [{ ranges: [{ startOffset: 1, endOffset: 4, count: 1 }] }] }], "test-2");
    collector.add([{ url: "https://app.test/app.js", source: "uvwxyz", functions: [{ ranges: [{ startOffset: 4, endOffset: 6, count: 1 }] }] }], "test-2");
    expect(collector.files[0]?.ranges).toEqual([{ start: 0, end: 4 }]);
    expect(collector.files[0]?.testIds).toEqual(["test-1", "test-2"]);
    expect(coverageTotals(collector.files)).toEqual({ covered: 6, total: 12, percent: 50 });
    expect(coverageTotals([]).percent).toBeNull();
  });

  test("marks missing source as an evidence gap rather than reporting an apparently complete denominator", () => {
    const collector = new BrowserCoverageCollector();
    collector.add([{ url: "https://app.test/missing.js", functions: [] }], "test-1");
    expect(coverageTotals(collector.files).percent).toBeNull();
    expect(collector.warnings[0]).toContain("https://app.test/missing.js");
  });

  test("retains usable evidence and a source-specific gap when a browser delivers an oversized script", () => {
    const collector = new BrowserCoverageCollector();
    collector.add([
      { url: "https://app.test/oversized.js", source: "x".repeat(1024 * 1024 + 1), functions: [] },
      { url: "https://app.test/small.js", source: "run();", functions: [{ ranges: [{ startOffset: 0, endOffset: 6, count: 1 }] }] },
    ], "test-1");
    const bounded = validateTestCoverageReport({ ...report(), files: collector.files, warnings: collector.warnings });
    expect(bounded.files.map(file => file.url)).toEqual(["https://app.test/small.js"]);
    expect(coverageTotals(bounded.files)).toEqual({ covered: 6, total: 6, percent: 100 });
    expect(bounded.warnings[0]).toContain("https://app.test/oversized.js");
  });

  test("rejects offsets and references that could misrepresent measured evidence", () => {
    const outOfBounds = report();
    outOfBounds.files[0]!.ranges[0]!.end = 7;
    expect(() => validateTestCoverageReport(outOfBounds)).toThrow("within source");
    const overlap = report();
    overlap.files[0]!.ranges.push({ start: 1, end: 4 });
    expect(() => validateTestCoverageReport(overlap)).toThrow("disjoint");
    const missingTest = report();
    missingTest.files[0]!.testIds = ["unknown-test"];
    expect(() => validateTestCoverageReport(missingTest)).toThrow("unknown");
    expect(coverageLineState("const emoji='😀';\r\nnever();\n \n", [{ start: 0, end: 6 }])).toEqual(["partial", "uncovered", "blank", "blank"]);
  });

  test("records the browser's executed function and leaves an uncalled function uncovered in the saved and delivered report", async () => {
    const temp = await createTempDir();
    const script = `function tested(){document.querySelector('#result').textContent='Verified';}\nfunction untouched(){return 'never executed';}\ndocument.querySelector('#tested').addEventListener('click',tested);`;
    let delivered: unknown;
    const server = createServer(async (request, response) => {
      if (request.url === "/api/test-coverage") {
        let body = "";
        for await (const chunk of request) body += chunk;
        delivered = JSON.parse(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ runId: validateTestCoverageReport(delivered).runId }));
      } else if (request.url === "/app.js") {
        response.writeHead(200, { "Content-Type": "application/javascript" });
        response.end(script);
      } else {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<button id="tested">Verify</button><p id="result">Waiting</p><script src="/app.js"></script>`);
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const specFile = await writeSpec(temp.dir, "coverage.blop.ts", `import { defineAgentTest } from "${process.cwd()}/src/index.ts"; export default defineAgentTest({name:'button updates result',goal:'Click Verify and assert Verified.'});`);
      const result = await runBlopTests({
        specFiles: [specFile], reportDir: join(temp.dir, ".blop"), streamFrames: false,
        coverage: true, coverageEndpoint: url,
        agentStream: async function* ({ nativeTools }) {
          const tools = nativeTools as NativeToolBridge[];
          const call = async (name: string, input: Record<string, unknown>) => {
            const tool = tools.find(candidate => candidate.name === name);
            if (!tool) throw new Error(`Missing tool ${name}`);
            return tool.execute(input);
          };
          await call("browser_goto", { url });
          await call("browser_click", { target: { role: "button", name: "Verify" } });
          await call("browser_expect_text", { text: "Verified" });
          await call("finish_test", { status: "passed", reason: "Button updates the rendered result." });
          yield { event_type: "done" };
        },
      });
      expect(result.status).toBe("passed");
      const saved = validateTestCoverageReport(JSON.parse(await readFile(join(temp.dir, ".blop/coverage.json"), "utf8")));
      expect(delivered).toEqual(saved);
      const file = saved.files.find(file => file.url === `${url}/app.js`)!;
      expect(file.source).toBe(script);
      const testedOffset = script.indexOf("document.querySelector('#result')");
      const untouchedOffset = script.indexOf("return 'never executed'");
      expect(file.ranges.some(range => range.start <= testedOffset && range.end > testedOffset)).toBe(true);
      expect(file.ranges.some(range => range.start <= untouchedOffset && range.end > untouchedOffset)).toBe(false);
      expect(file.testIds).toEqual([result.results[0]!.id]);
      expect(coverageTotals([file]).percent).toBeLessThan(100);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await temp.cleanup();
    }
  }, 30_000);
});
