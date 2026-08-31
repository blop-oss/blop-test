/**
 * Turn what the runner saw into the bounded signal vocabulary (#369).
 *
 * This is the only place that reads `browserLogs` and `actions` for
 * classification, and the only place that decides what leaves the runner. Raw
 * console text, DOM and request URLs stay here; a signal name crosses the
 * wire. That boundary is deliberate - shipping the payloads themselves is what
 * the privacy tier in #383 is for.
 */

import { signalsFromMessage, signalsFromAppText } from "@blopai/ingest/classify";
import type { FailureSignal } from "@blopai/ingest/classify";
import type { BlopAction, BlopBrowserLog, BlopTestStatus } from "../runtime/types.js";
import { NON_STEP_TOOLS } from "./otel-attributes.js";

export type FailureEvidenceSource = {
  status: BlopTestStatus;
  reason: string;
  attempts: number;
  firstAttemptStatus: BlopTestStatus | null;
  baseUrl: string | null;
  browserLogs: readonly BlopBrowserLog[];
  actions: readonly BlopAction[];
  startedAt: string;
  finishedAt: string;
};

/**
 * How far either side of the failing step a browser log still counts as
 * related to it. Without a window, an app that logs a console error on every
 * page load would push every failure in that project toward one class -
 * deterministic, and consistently wrong for that one project, which is exactly
 * what "the same root cause lands in the same class" forbids. Correlating in
 * time is the only fix available that needs no per-project configuration.
 */
const CORRELATION_LEAD_IN_MS = 1000;

/** Tools whose failure is a user gesture that did not land in time. */
const INTERACTION_TOOLS = new Set([
  "browser_click",
  "browser_click_at",
  "browser_double_click",
  "browser_right_click",
  "browser_hover",
  "browser_drag_and_drop",
  "browser_type",
  "browser_clear",
  "browser_check",
  "browser_uncheck",
  "browser_select_option",
  "browser_upload_file",
  "browser_focus",
  "browser_blur",
  "browser_press",
]);

/** The signal a failing tool implies on its own, before any text is read. */
const TOOL_SIGNALS: Record<string, FailureSignal> = {
  browser_wait_for_network_idle: "network_idle_timeout",
  browser_wait_for_selector: "wait_for_selector_timeout",
  browser_expect_count: "expect_count_mismatch",
};

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function signalsFromTestResult(source: FailureEvidenceSource): {
  signals: FailureSignal[];
  failingTool: string | null;
} {
  // Only the reason gets the gate rules: it is the runner's own error text.
  // Everything below is written by the app under test and goes through
  // signalsFromAppText, which cannot produce a gate signal.
  const signals = new Set<FailureSignal>(signalsFromMessage(source.reason));
  const appOrigin = originOf(source.baseUrl);

  // The failing step is the last real action that recorded an error, falling
  // back to the last real action at all when the harness recorded none.
  // `metadata.error` is set by the browser harness whenever a tool throws, so
  // this is structural rather than a read of prose.
  let failingTool: string | null = null;
  let failingError = "";
  let failingAction: BlopAction | null = null;
  for (const action of source.actions) {
    if (NON_STEP_TOOLS.has(action.name)) continue;
    const error = typeof action.metadata?.error === "string" ? action.metadata.error : "";
    if (error) {
      failingTool = action.name;
      failingError = error;
      failingAction = action;
    } else if (failingTool === null) {
      failingTool = action.name;
      failingAction = action;
    }
  }

  // An agent that produced no action at all never reached the app. The
  // provider branches in the runner all end this way and their wording is not
  // a contract, so this is read structurally.
  if (source.status === "error" && source.actions.length === 0) {
    signals.add("agent_provider_error");
  }

  const windowStart = failingAction
    ? Date.parse(failingAction.timestamp) - CORRELATION_LEAD_IN_MS
    : Date.parse(source.startedAt);
  const windowEnd = failingAction
    ? Date.parse(failingAction.timestamp) + failingAction.durationMs + CORRELATION_LEAD_IN_MS
    : Date.parse(source.finishedAt);
  const inWindow = (log: BlopBrowserLog): boolean => {
    const at = Date.parse(log.timestamp);
    // An unparseable timestamp is not evidence of unrelatedness; keep it.
    if (Number.isNaN(at) || Number.isNaN(windowStart) || Number.isNaN(windowEnd)) return true;
    return at >= windowStart && at <= windowEnd;
  };

  for (const log of source.browserLogs) {
    if (!inWindow(log)) continue;
    if (log.type === "pageerror") {
      signals.add("page_error");
      continue;
    }
    if (log.type === "requestfailed") {
      const sameOrigin = appOrigin !== null && originOf(log.url) === appOrigin;
      // A network-level failure only counts as infrastructure when it is the
      // app's own origin refusing or failing to resolve. A third-party script
      // going dark is noise, and must never trip the gate.
      if (sameOrigin && /ERR_CONNECTION_(REFUSED|RESET)/i.test(log.message)) {
        signals.add("connection_refused");
      } else if (sameOrigin && /ERR_NAME_NOT_RESOLVED/i.test(log.message)) {
        signals.add("dns_failure");
      }
      signals.add(sameOrigin ? "request_failed_app_origin" : "request_failed_third_party");
      continue;
    }
    // console. `level` is the console severity here; on the other two types it
    // smuggles `attempt:N` instead (runner.ts:933, :941), so it is only read
    // after `type` has been narrowed by the two branches above.
    if (log.level === "error") {
      for (const signal of signalsFromAppText(log.message)) signals.add(signal);
    }
  }

  if (failingTool) {
    const toolSignal = TOOL_SIGNALS[failingTool];
    if (toolSignal) signals.add(toolSignal);
    else if (failingTool.startsWith("browser_expect_")) signals.add("assertion_mismatch");
    if (INTERACTION_TOOLS.has(failingTool) && /timed out|timeout/i.test(failingError || source.reason)) {
      signals.add("interaction_timeout");
    }
    if (failingError) {
      for (const signal of signalsFromAppText(failingError)) signals.add(signal);
    }
  }

  // #367's counter, in its only reachable direction here: a test that went
  // green on a retry never becomes a top_failure, so `passed_on_retry` has no
  // consumer and is not in the vocabulary. Its negation does.
  if (source.status !== "passed" && source.attempts > 1) {
    signals.add("deterministic_failure");
  }

  return { signals: [...signals], failingTool };
}
