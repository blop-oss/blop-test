import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlopAgentEvent, BlopReporter, BlopRunResult } from "../runtime/types.js";

export async function writeReports(reportDir: string, result: BlopRunResult, reporter: BlopReporter = "all") {
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(reportDir, "events.jsonl"), toJsonLines(result.results.flatMap((test) => test.events)));

  if (reporter === "junit" || reporter === "all") {
    await writeFile(join(reportDir, "report.xml"), toJunit(result));
  }
}

function toJsonLines(events: BlopAgentEvent[]) {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

function toJunit(result: BlopRunResult) {
  const failures = result.results.filter((test) => test.status !== "passed");
  const cases = result.results.map((test) => {
    const failure = test.status === "passed" ? "" : `<failure message=${quote(test.reason)}>${escapeXml(test.reason)}</failure>`;
    return `<testcase classname="blop" name=${quote(test.name)} time=${quote(String(test.durationMs / 1000))}>${failure}</testcase>`;
  });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="blop" tests=${quote(String(result.results.length))} failures=${quote(String(failures.length))} time=${quote(String(result.durationMs / 1000))}>`,
    ...cases,
    `</testsuite>`,
    ``,
  ].join("\n");
}

function quote(value: string) {
  return `"${escapeXml(value)}"`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
