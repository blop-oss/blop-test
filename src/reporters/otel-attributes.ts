import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_CICD_PIPELINE_ACTION_NAME,
  ATTR_CICD_PIPELINE_NAME,
  ATTR_CICD_PIPELINE_RUN_ID,
  ATTR_CICD_PIPELINE_RUN_URL_FULL,
  ATTR_VCS_CHANGE_ID,
  ATTR_VCS_REF_HEAD_NAME,
  ATTR_VCS_REF_HEAD_REVISION,
  ATTR_VCS_REF_HEAD_TYPE,
  ATTR_VCS_REPOSITORY_URL_FULL,
  CICD_PIPELINE_ACTION_NAME_VALUE_RUN,
  TEST_SUITE_RUN_STATUS_VALUE_ABORTED,
  TEST_SUITE_RUN_STATUS_VALUE_FAILURE,
  TEST_SUITE_RUN_STATUS_VALUE_SUCCESS,
  TEST_SUITE_RUN_STATUS_VALUE_TIMED_OUT,
} from "@opentelemetry/semantic-conventions/incubating";
import type { BlopAction, BlopCiMetadata, BlopTestStatus } from "../runtime/types.js";
import { classifyFailure, type FailureSignal } from "@blopai/ingest/classify";

/**
 * Blop-specific attributes live under their own namespace. The OpenTelemetry
 * naming guidance is explicit that you must not prefix your own attributes
 * with a namespace the specification owns, because it will collide when they
 * later define that name themselves.
 */
export const ATTR_BLOP_RUN_ID = "blop.run.id";
export const ATTR_BLOP_JOURNEY_ID = "blop.journey.id";
export const ATTR_BLOP_SCENARIO_PATH = "blop.scenario.path";
export const ATTR_BLOP_SCENARIO_ATTEMPTS = "blop.scenario.attempts";
export const ATTR_BLOP_FAILURE_CATEGORY = "blop.failure.category";
export const ATTR_BLOP_FAILURE_CONFIDENCE = "blop.failure.confidence";
export const ATTR_BLOP_STEP_TOOL = "blop.step.tool";
export const ATTR_BLOP_STEP_URL = "blop.step.url";
export const ATTR_BLOP_BASE_URL = "blop.base_url";
export const ATTR_BLOP_AGENT_PROVIDER = "blop.agent.provider";
export const ATTR_BLOP_AGENT_MODEL = "blop.agent.model";
export const ATTR_BLOP_RECOVERY_KIND = "blop.recovery.kind";
export const ATTR_BLOP_TOKEN_KIND = "blop.token.kind";
export const ATTR_BLOP_TEAM = "blop.team";

/**
 * Tools that are bookkeeping rather than a step against the app. `finish_test`
 * records the verdict and `record_critical_point` annotates evidence; both are
 * kept as span events so the timeline stays complete without inventing steps.
 */
export const NON_STEP_TOOLS = new Set(["finish_test", "record_critical_point"]);

/** Longest attribute value we copy off a tool input. */
const MAX_ATTRIBUTE_LENGTH = 256;

/** The root describe block. `checkout > applies discount` gives `checkout`. */
export function journeyId(testName: string): string {
  const [root] = testName.split(" > ");
  return (root ?? testName).trim() || testName;
}

/**
 * Coarse bucket for why a scenario did not pass, derived from the runner's own
 * failure wording. Kept deliberately small so it stays usable as a metric
 * dimension.
 */
export function failureCategory(status: BlopTestStatus, reason: string): string {
  if (/timed out/i.test(reason)) return "timeout";
  if (/appears to be stuck/i.test(reason)) return "stall";
  if (/without calling finish_test/i.test(reason)) return "agent_incomplete";
  if (/Failed to (create|load)/i.test(reason)) return "infrastructure";
  return status === "failed" ? "assertion" : "error";
}

/**
 * The value `blop.failure.category` carries (#369).
 *
 * Prefers the classified cause - the same verdict the platform stores on the
 * triage cluster, because it is the same function over the same signals - and
 * falls back to {@link failureCategory}'s symptom buckets for a failure the
 * classifier will not commit on, and for runs that carry no signals at all.
 *
 * A null confidence is the reliable marker that a value came from the
 * fallback rather than from the classifier.
 */
export function resolveFailureCategory(
  status: BlopTestStatus,
  reason: string,
  signals: readonly FailureSignal[],
  failingTool: string | null,
): { category: string; confidence: number | null } {
  const verdict = classifyFailure({
    signals,
    failingTool,
    hasRunnerEvidence: signals.length > 0,
  });
  if (verdict.failureClass !== "unknown") {
    return { category: verdict.failureClass, confidence: verdict.confidence };
  }
  return { category: failureCategory(status, reason), confidence: null };
}

export function suiteRunStatus(status: BlopTestStatus, timedOut = false): string {
  if (timedOut) return TEST_SUITE_RUN_STATUS_VALUE_TIMED_OUT;
  if (status === "passed") return TEST_SUITE_RUN_STATUS_VALUE_SUCCESS;
  if (status === "failed") return TEST_SUITE_RUN_STATUS_VALUE_FAILURE;
  // Blop's "error" means the harness or agent broke, not that the app failed.
  return TEST_SUITE_RUN_STATUS_VALUE_ABORTED;
}

export function agentAttributes(provider?: string | null, model?: string | null): Attributes {
  return {
    ...(provider ? { [ATTR_BLOP_AGENT_PROVIDER]: provider } : {}),
    ...(model ? { [ATTR_BLOP_AGENT_MODEL]: model } : {}),
  };
}

export function ciAttributes(ci: BlopCiMetadata): Attributes {
  if (!ci.provider) return {};

  return {
    [ATTR_CICD_PIPELINE_ACTION_NAME]: CICD_PIPELINE_ACTION_NAME_VALUE_RUN,
    ...(ci.workflowName ? { [ATTR_CICD_PIPELINE_NAME]: ci.workflowName } : {}),
    ...(ci.runId ? { [ATTR_CICD_PIPELINE_RUN_ID]: ci.runId } : {}),
    ...(ci.runUrl ? { [ATTR_CICD_PIPELINE_RUN_URL_FULL]: ci.runUrl } : {}),
    ...(ci.repositoryUrl ? { [ATTR_VCS_REPOSITORY_URL_FULL]: ci.repositoryUrl } : {}),
    ...(ci.branch ? { [ATTR_VCS_REF_HEAD_NAME]: ci.branch } : {}),
    ...(ci.commitSha ? { [ATTR_VCS_REF_HEAD_REVISION]: ci.commitSha } : {}),
    ...(ci.refType ? { [ATTR_VCS_REF_HEAD_TYPE]: ci.refType } : {}),
    ...(ci.pullRequestNumber ? { [ATTR_VCS_CHANGE_ID]: ci.pullRequestNumber } : {}),
  };
}

/**
 * Only the URL a step acted on. Typed text, extracted page content, DOM
 * snapshots, and arbitrary target/selector text are deliberately excluded:
 * spans carry pointers, never payloads, and tool inputs can hold credentials
 * or free-form failure wording that must not reach a third-party collector.
 */
export function stepInputAttributes(input: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  if (typeof input.url === "string") {
    attributes[ATTR_BLOP_STEP_URL] = truncate(sanitizeUrl(input.url));
  }
  return attributes;
}

export function stepEventAttributes(action: BlopAction): Attributes {
  return {
    [ATTR_BLOP_STEP_TOOL]: action.name,
    "blop.step.duration_ms": action.durationMs,
  };
}

export function actionError(action: BlopAction): string | null {
  return typeof action.metadata?.error === "string" ? action.metadata.error : null;
}

/**
 * Basic-auth credentials and token-bearing query parameters routinely appear in
 * staging URLs. The collector is a third-party system, so strip them before a
 * URL becomes a span attribute; parameter names are kept so the shape of the
 * request is still legible.
 */
const SENSITIVE_PARAM = /(token|key|secret|password|passwd|auth|signature|sig)/i;

export function sanitizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL (a relative path, say); nothing to strip.
    return value;
  }

  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, "REDACTED");
  }

  return url.toString();
}

export function truncate(value: string): string {
  return value.length > MAX_ATTRIBUTE_LENGTH ? `${value.slice(0, MAX_ATTRIBUTE_LENGTH)}...` : value;
}
