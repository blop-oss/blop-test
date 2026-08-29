import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { BlopRunResult, BlopTestResult } from "../runtime/types.js";
import { createIngestClient, type ArtifactPointer, type Counts, type TopFailure, type TestCaseResult, type CiMetadata } from "@blopai/ingest";

export type UploadOptions = {
  /** Base URL of the blop web app serving /api/ingest. */
  ingestUrl?: string;
  /** Per-project ingest secret. */
  ingestSecret?: string;
  /** Project id the run belongs to. */
  projectId?: string;
  /** Run id (defaults to the BlopRunResult.runId). */
  runId?: string;
  /** Trigger source. */
  trigger?: string;
  /** Report directory to zip as a report_bundle artifact. */
  reportDir?: string;
  /** Skip artifact upload (e.g. when R2 is not configured). */
  skipArtifacts?: boolean;
  /** W3C context that correlates platform ingest with the runner trace. */
  traceparent?: string;
  tracestate?: string;
};

/**
 * Upload a BlopRunResult to the Blop platform via CloudEvents.
 *
 * Replaces the legacy single-POST upload with the CloudEvents ingest
 * protocol (qa.run.started.v1 + qa.run.finished.v1 + presigned artifacts),
 * sharing the same wire contract as every other test runner adapter.
 *
 * Best-effort: errors are thrown to the caller, which should catch and log.
 * Returns the run id and uploaded artifact pointers.
 */
export async function uploadRunToPlatform(options: UploadOptions & { result: BlopRunResult }): Promise<{
  uploaded: boolean;
  reason?: string;
  runId?: string;
  artifacts?: ArtifactPointer[];
}> {
  const { result, reportDir, skipArtifacts } = options;

  const client = createIngestClient({
    ingestUrl: options.ingestUrl,
    ingestSecret: options.ingestSecret,
    projectId: options.projectId,
    runId: options.runId ?? result.runId,
    trigger: options.trigger,
    traceparent: options.traceparent,
    tracestate: options.tracestate,
  });

  if (!client) {
    return { uploaded: false, reason: "platform_not_configured" };
  }

  const ci = toCiMetadata(result.results[0]?.ci);
  const counts = computeCounts(result.results);
  const topFailures = extractFailures(result.results);
  const tests = toTestResults(result.results);
  const status = result.status === "passed" ? "passed" : "failed";

  await client.emitStarted();

  const artifacts: ArtifactPointer[] = [];

  if (!skipArtifacts && reportDir && existsSync(reportDir)) {
    const bundle = zipReportDir(reportDir);
    if (bundle) {
      const uploadResult = await client.uploadArtifact({
        filename: "blop-report-bundle.zip",
        contentType: "application/zip",
        bytes: bundle,
      });
      if (uploadResult.uploaded && uploadResult.artifact) {
        artifacts.push(uploadResult.artifact);
      }
    }
  }

  await client.emitFinished({
    status,
    counts,
    durationMs: result.durationMs,
    topFailures,
    tests,
    artifacts,
    ci,
  });

  return { uploaded: true, runId: client.runId, artifacts };
}

function computeCounts(results: BlopTestResult[]): Counts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const test of results) {
    if (test.status === "passed") passed++;
    else if (test.status === "failed" || test.status === "error") failed++;
  }
  return { passed, failed, skipped, flaky: 0 };
}

function extractFailures(results: BlopTestResult[]): TopFailure[] {
  const failures: TopFailure[] = [];
  for (const test of results) {
    if (test.status === "passed") continue;
    const testFile = test.name || "unknown";
    const message = test.reason || `${test.name} ${test.status}`;
    failures.push({ test_file: testFile, message });
  }
  return failures;
}

function toTestResults(results: BlopTestResult[]): TestCaseResult[] {
  const tests: TestCaseResult[] = [];
  for (const test of results) {
    if (test.synthetic) continue;
    const entry: TestCaseResult = {
      suite: "blop",
      classname: test.specFile ?? "",
      name: test.name,
      status: test.status,
      duration_ms: test.durationMs,
    };
    if (test.attempts > 1) entry.attempts = test.attempts;
    if (test.status !== "passed" && test.reason) entry.message = test.reason;
    tests.push(entry);
  }
  return tests;
}

function toCiMetadata(ci?: { provider: string | null; runId: string | null; branch: string | null; commitSha: string | null }): CiMetadata | undefined {
  if (!ci || !ci.provider) return undefined;
  const out: CiMetadata = {};
  if (ci.branch) out.branch = ci.branch;
  if (ci.commitSha) out.commit_sha = ci.commitSha;
  return Object.keys(out).length > 0 ? out : undefined;
}

function zipReportDir(reportDir: string): Uint8Array | null {
  try {
    const tmpZip = join(reportDir, "..blop-report-bundle.zip");
    execSync(`zip -qr "${tmpZip}" .`, { cwd: reportDir });
    const buf = readFileSync(tmpZip);
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}
