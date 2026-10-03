import type { Page } from "playwright";

/** Executed half-open UTF-16 offsets in the JavaScript delivered to Chromium. */
export type CoverageRange = { start: number; end: number };
export type V8CoverageRange = { startOffset: number; endOffset: number; count: number };
type JSCoverageEntry = { url: string; source?: string; functions: { ranges: V8CoverageRange[] }[] };
export type TestCoverageFile = {
  url: string;
  source: string;
  ranges: CoverageRange[];
  testIds: string[];
};
export type TestCoverageReport = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  browser: "chromium";
  tests: { id: string; name: string; status: "passed" | "failed" | "error" }[];
  files: TestCoverageFile[];
  warnings: string[];
};
export const TEST_COVERAGE_MAX_BODY_BYTES = 8 * 1024 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function fail(message: string): never { throw new Error(`Invalid test coverage: ${message}`); }
const text = (value: unknown, max: number, field: string): string =>
  typeof value === "string" && value.length <= max ? value : fail(field);
const id = (value: unknown, field: string): string =>
  typeof value === "string" && identifier.test(value) ? value : fail(field);
const fields = (value: Record<string, unknown>, allowed: string[], label: string) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}: unknown field`);
};

/** Shared wire validation. Bounded independently of collector HTTP configuration. */
export function validateTestCoverageReport(value: unknown): TestCoverageReport {
  if (!record(value)) fail("expected a report object");
  fields(value, ["schemaVersion", "runId", "startedAt", "finishedAt", "browser", "tests", "files", "warnings"], "report");
  if (value.schemaVersion !== 1 || value.browser !== "chromium") fail("unsupported schema or browser");
  id(value.runId, "runId");
  for (const key of ["startedAt", "finishedAt"]) {
    const date = text(value[key], 40, key);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(date) || !Number.isFinite(Date.parse(date))) fail(key);
  }
  if (Date.parse(value.finishedAt as string) < Date.parse(value.startedAt as string)) fail("finishedAt precedes startedAt");
  if (!Array.isArray(value.tests) || value.tests.length > 500) fail("tests: maximum 500");
  const testIds = new Set<string>();
  for (const test of value.tests) {
    if (!record(test)) fail("test object");
    fields(test, ["id", "name", "status"], "test");
    const testId = id(test.id, "test.id");
    if (testIds.has(testId)) fail("duplicate test id");
    testIds.add(testId);
    if (!text(test.name, 512, "test.name").trim()) fail("empty test name");
    if (!["passed", "failed", "error"].includes(test.status as string)) fail("test.status");
  }
  if (!Array.isArray(value.files) || value.files.length > 200) fail("files: maximum 200");
  let sourceBytes = 0;
  let rangeCount = 0;
  for (const file of value.files) {
    if (!record(file)) fail("file object");
    fields(file, ["url", "source", "ranges", "testIds"], "file");
    if (!text(file.url, 4096, "file.url").trim()) fail("empty file URL");
    const source = text(file.source, 1024 * 1024, "file.source");
    sourceBytes += Buffer.byteLength(source);
    if (sourceBytes > 6 * 1024 * 1024) fail("aggregate source exceeds 6 MiB");
    if (!Array.isArray(file.ranges) || file.ranges.length > 20_000) fail("file.ranges: maximum 20000");
    rangeCount += file.ranges.length;
    if (rangeCount > 100_000) fail("aggregate ranges exceed 100000");
    let end = -1;
    for (const range of file.ranges) {
      if (!record(range)) fail("range object");
      fields(range, ["start", "end"], "range");
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          (range.start as number) < 0 || (range.start as number) <= end ||
          (range.end as number) <= (range.start as number) || (range.end as number) > source.length) fail("ranges must be nonempty, sorted, disjoint and merged within source");
      end = range.end as number;
    }
    if (!Array.isArray(file.testIds) || !file.testIds.length || file.testIds.length > 500) fail("file.testIds");
    const seen = new Set<string>();
    for (const testId of file.testIds) {
      if (!testIds.has(id(testId, "file.testIds")) || seen.has(testId)) fail("unknown or duplicate file test id");
      seen.add(testId);
    }
  }
  if (!Array.isArray(value.warnings) || value.warnings.length > 100) fail("warnings: maximum 100");
  for (const warning of value.warnings) text(warning, 2000, "warning");
  if (Buffer.byteLength(JSON.stringify(value)) > TEST_COVERAGE_MAX_BODY_BYTES) fail("report exceeds 8 MiB");
  return value as TestCoverageReport;
}

export function mergeCoverageRanges(ranges: readonly CoverageRange[]): CoverageRange[] {
  const sorted = ranges.filter(range => range.end > range.start).map(range => ({ ...range })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: CoverageRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

/** V8's nested block counts override their enclosing function/script count. */
export function executedCoverageRanges(functions: readonly { ranges: readonly V8CoverageRange[] }[]): CoverageRange[] {
  const points = functions.flatMap(fn => fn.ranges.flatMap(range => [
    { offset: range.startOffset, start: true, range },
    { offset: range.endOffset, start: false, range },
  ])).sort((a, b) => a.offset - b.offset ||
    Number(a.start) - Number(b.start) ||
    (a.start ? b.range.endOffset - a.range.endOffset || a.range.count - b.range.count
      : b.range.startOffset - a.range.startOffset || b.range.count - a.range.count));
  const counts: number[] = [];
  const executed: CoverageRange[] = [];
  let previous = 0;
  for (const point of points) {
    if (point.offset > previous && (counts[counts.length - 1] ?? 0) > 0) {
      const last = executed[executed.length - 1];
      if (last?.end === previous) last.end = point.offset;
      else executed.push({ start: previous, end: point.offset });
    }
    if (point.start) counts.push(point.range.count);
    else counts.pop();
    previous = point.offset;
  }
  return executed;
}

export function coverageTotals(files: readonly TestCoverageFile[]) {
  let total = 0;
  let covered = 0;
  for (const file of files) {
    total += file.source.length;
    for (const range of file.ranges) covered += range.end - range.start;
  }
  return { total, covered, percent: total ? covered / total * 100 : null };
}

/** Line evidence is partial when only some non-whitespace source on that line ran. */
export function coverageLineState(source: string, ranges: readonly CoverageRange[]): ("covered" | "partial" | "uncovered" | "blank")[] {
  let offset = 0;
  let rangeIndex = 0;
  return [...source.matchAll(/([^\r\n\u2028\u2029]*)(\r\n|[\r\n\u2028\u2029]|$)/g)].map(match => {
    const line = match[1]!;
    let total = 0;
    let covered = 0;
    for (let index = 0; index < line.length; index++) {
      if (/\s/.test(line[index]!)) continue;
      const position = offset + index;
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= position) rangeIndex++;
      total++;
      if (rangeIndex < ranges.length && ranges[rangeIndex]!.start <= position) covered++;
    }
    offset += match[0].length;
    return total === 0 ? "blank" : covered === total ? "covered" : covered === 0 ? "uncovered" : "partial";
  });
}

/** Per-run collector: repeated executions union offsets rather than inflate coverage. */
export class BrowserCoverageCollector {
  readonly files: TestCoverageFile[] = [];
  readonly warnings: string[] = [];
  private readonly byUrl = new Map<string, TestCoverageFile[]>();
  private readonly fileSizes = new WeakMap<TestCoverageFile, { base: number; total: number }>();
  private payloadBytes = 0;
  private rangeCount = 0;
  warn(message: string) {
    const bounded = message.slice(0, 2000);
    if (!this.warnings.includes(bounded) && this.warnings.length < 100) this.warnings.push(bounded);
  }
  async start(page: Page): Promise<boolean> {
    try {
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
      return true;
    } catch (error) {
      this.warn(`JavaScript coverage could not start: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  async stop(page: Page, testId: string): Promise<void> {
    try { this.add(await page.coverage.stopJSCoverage(), testId); }
    catch (error) { this.warn(`JavaScript coverage could not be collected from a page (closed pages are unavailable): ${error instanceof Error ? error.message : String(error)}`); }
  }
  add(entries: readonly JSCoverageEntry[], testId: string) {
    for (const entry of entries) {
      if (!entry.url) continue;
      if (entry.source === undefined) {
        this.warn(`Source unavailable for measured script: ${entry.url}. Its characters are excluded from coverage totals.`);
        continue;
      }
      if (entry.url.length > 4096 || entry.source.length > 1024 * 1024) {
        this.warn(`Script exceeds the retained URL/source limit: ${entry.url}. Its characters are excluded from coverage totals.`);
        continue;
      }
      const candidates = this.byUrl.get(entry.url) ?? [];
      const existing = candidates.find(candidate => candidate.source === entry.source);
      if (!existing && this.files.length >= 200) {
        this.warn(`Coverage file limit reached: ${entry.url}. This script is excluded from coverage totals.`);
        continue;
      }
      const file = existing ?? { url: entry.url, source: entry.source, ranges: [], testIds: [] };
      const ranges = mergeCoverageRanges([...file.ranges, ...executedCoverageRanges(entry.functions)]);
      const testIds = file.testIds.includes(testId) ? file.testIds : [...file.testIds, testId];
      const previous = this.fileSizes.get(file);
      // Serialize the large, immutable source once. Reserve 3 MiB of the wire
      // limit for bounded test identities and warnings, including JSON escaping.
      const base = previous?.base ?? Buffer.byteLength(JSON.stringify(file));
      const total = base + Buffer.byteLength(JSON.stringify(ranges)) + Buffer.byteLength(JSON.stringify(testIds)) - 4;
      const payloadBytes = this.payloadBytes - (previous?.total ?? 0) + total;
      const rangeCount = this.rangeCount - file.ranges.length + ranges.length;
      if (ranges.length > 20_000 || rangeCount > 100_000 || testIds.length > 500 || payloadBytes > 5 * 1024 * 1024) {
        this.warn(`Coverage evidence limit reached: ${entry.url}. This measurement is excluded; any earlier retained evidence remains.`);
        continue;
      }
      if (!existing) {
        candidates.push(file);
        this.byUrl.set(entry.url, candidates);
        this.files.push(file);
      }
      file.ranges = ranges;
      file.testIds = testIds;
      this.fileSizes.set(file, { base, total });
      this.payloadBytes = payloadBytes;
      this.rangeCount = rangeCount;
    }
  }
}
