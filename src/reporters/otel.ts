import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  ATTR_CICD_PIPELINE_ACTION_NAME,
  ATTR_CICD_PIPELINE_NAME,
  ATTR_CICD_PIPELINE_RESULT,
  ATTR_CICD_PIPELINE_RUN_ID,
  ATTR_CICD_PIPELINE_RUN_URL_FULL,
  ATTR_TEST_CASE_NAME,
  ATTR_TEST_CASE_RESULT_STATUS,
  ATTR_TEST_SUITE_NAME,
  ATTR_TEST_SUITE_RUN_STATUS,
  ATTR_VCS_CHANGE_ID,
  ATTR_VCS_REF_HEAD_NAME,
  ATTR_VCS_REF_HEAD_REVISION,
  ATTR_VCS_REF_HEAD_TYPE,
  ATTR_VCS_REPOSITORY_URL_FULL,
  CICD_PIPELINE_ACTION_NAME_VALUE_RUN,
  CICD_PIPELINE_RESULT_VALUE_ERROR,
  CICD_PIPELINE_RESULT_VALUE_FAILURE,
  CICD_PIPELINE_RESULT_VALUE_SUCCESS,
  TEST_CASE_RESULT_STATUS_VALUE_FAIL,
  TEST_CASE_RESULT_STATUS_VALUE_PASS,
  TEST_SUITE_RUN_STATUS_VALUE_ABORTED,
  TEST_SUITE_RUN_STATUS_VALUE_FAILURE,
  TEST_SUITE_RUN_STATUS_VALUE_SUCCESS,
} from "@opentelemetry/semantic-conventions/incubating";
import type { BlopOtelConfig } from "../node/otel-config.js";
import type { BlopAction, BlopCiMetadata, BlopTestStatus } from "../runtime/types.js";

const TRACER_NAME = "@blopai/cli";

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
export const ATTR_BLOP_STEP_TOOL = "blop.step.tool";
export const ATTR_BLOP_BASE_URL = "blop.base_url";
export const ATTR_BLOP_AGENT_PROVIDER = "blop.agent.provider";
export const ATTR_BLOP_AGENT_MODEL = "blop.agent.model";

/**
 * Tools that are bookkeeping rather than a step against the app. `finish_test`
 * records the verdict and `record_critical_point` annotates evidence; both are
 * kept as span events so the timeline stays complete without inventing steps.
 */
const NON_STEP_TOOLS = new Set(["finish_test", "record_critical_point"]);

/**
 * `browser_run_steps` batches several tools into one call, and the harness
 * records an action for the batch *and* for each inner step. The inner actions
 * arrive first, so by the time the batch action lands its children are already
 * emitted. Emitting the batch as a span too would produce a sibling that
 * overlaps its own children, which reads as broken in a waterfall, so the batch
 * is recorded as an event instead. Real nesting needs the pre-execution hook
 * that trace propagation introduces in the next cut.
 */
const BATCH_TOOL = "browser_run_steps";

/** Longest attribute value we copy off a tool input. */
const MAX_ATTRIBUTE_LENGTH = 256;

/**
 * Hard ceiling on how long shutdown may wait for the collector. The OTLP
 * exporter retries with backoff, so an unreachable collector would otherwise
 * add ~8s to every run. Telemetry is allowed to be lost; it is not allowed to
 * slow the suite down.
 */
const FLUSH_TIMEOUT_MS = 5_000;
/** Per-attempt ceiling, so a hung collector cannot consume the whole budget. */
const EXPORT_TIMEOUT_MS = 3_000;

export type BlopOtelScenarioSpan = {
  /** Open a `scenario.retry` span for attempts after the first. */
  beginAttempt(attempt: number): void;
  recordStep(action: BlopAction): void;
  recordResume(resume: number, max: number): void;
  end(input: { status: BlopTestStatus; reason: string; attempts: number }): void;
};

export type BlopOtelRunSpan = {
  startScenario(input: {
    name: string;
    specFile?: string;
    baseUrl?: string | null;
  }): BlopOtelScenarioSpan;
  end(input: { status: BlopTestStatus; finishedAt: Date }): Promise<void>;
};

export type BlopOtelRunInput = {
  runId: string;
  suiteName: string;
  startedAt: Date;
  ci: BlopCiMetadata;
  provider?: string | null;
  model?: string | null;
};

export function startOtelRun(config: BlopOtelConfig, input: BlopOtelRunInput): BlopOtelRunSpan {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
    // Test volume is trivial next to production traffic and a sampled test
    // trace is useless, so never sample.
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: config.tracesUrl,
          headers: config.headers,
          timeoutMillis: EXPORT_TIMEOUT_MS,
        }),
        { exportTimeoutMillis: EXPORT_TIMEOUT_MS },
      ),
    ],
  });

  // Deliberately not registered as the global provider. Scenarios interleave on
  // one event loop under --workers, so every parent context is threaded
  // explicitly and an ambient active-span stack would cross-link them.
  const tracer = provider.getTracer(TRACER_NAME);

  const runSpan = tracer.startSpan(
    `blop run ${input.suiteName}`,
    {
      kind: SpanKind.SERVER,
      startTime: input.startedAt,
      attributes: {
        [ATTR_BLOP_RUN_ID]: input.runId,
        [ATTR_TEST_SUITE_NAME]: input.suiteName,
        ...agentAttributes(input.provider, input.model),
        ...ciAttributes(input.ci),
      },
    },
    ROOT_CONTEXT,
  );
  const runContext = trace.setSpan(ROOT_CONTEXT, runSpan);

  return {
    startScenario: (scenario) => startScenario(tracer, runContext, scenario),
    end: async ({ status, finishedAt }) => {
      runSpan.setAttribute(ATTR_TEST_SUITE_RUN_STATUS, suiteRunStatus(status));
      if (input.ci.provider) {
        runSpan.setAttribute(ATTR_CICD_PIPELINE_RESULT, pipelineResult(status));
      }
      if (status !== "passed") {
        runSpan.setStatus({ code: SpanStatusCode.ERROR });
      }
      runSpan.end(finishedAt);

      // Telemetry must never fail a run, and the CLI calls process.exit right
      // after the summary prints, so the flush has to complete here.
      try {
        await withTimeout(provider.forceFlush(), "flush");
      } catch (error) {
        warn(`Failed to flush OpenTelemetry spans: ${message(error)}`);
      }
      try {
        await withTimeout(provider.shutdown(), "shutdown");
      } catch {
        // Already down, or the collector never answered; nothing left to do.
      }
    },
  };
}

function startScenario(
  tracer: ReturnType<NodeTracerProvider["getTracer"]>,
  runContext: Context,
  input: { name: string; specFile?: string; baseUrl?: string | null },
): BlopOtelScenarioSpan {
  const scenarioSpan = tracer.startSpan(
    input.name,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_TEST_CASE_NAME]: input.name,
        [ATTR_BLOP_JOURNEY_ID]: journeyId(input.name),
        ...(input.specFile ? { [ATTR_BLOP_SCENARIO_PATH]: input.specFile } : {}),
        ...(input.baseUrl ? { [ATTR_BLOP_BASE_URL]: sanitizeUrl(input.baseUrl) } : {}),
      },
    },
    runContext,
  );
  const scenarioContext = trace.setSpan(runContext, scenarioSpan);

  // Attempt 1 hangs its steps directly off the scenario so the common trace is
  // exactly run > scenario > step. A retry is the exception, so it earns a span.
  let attemptSpan: Span | null = null;
  let stepContext = scenarioContext;

  const closeAttempt = (endTime?: Date) => {
    if (!attemptSpan) return;
    attemptSpan.end(endTime);
    attemptSpan = null;
    stepContext = scenarioContext;
  };

  return {
    beginAttempt(attempt) {
      closeAttempt();
      if (attempt < 2) return;

      attemptSpan = tracer.startSpan(
        "scenario.retry",
        { kind: SpanKind.INTERNAL, attributes: { [ATTR_BLOP_SCENARIO_ATTEMPTS]: attempt } },
        scenarioContext,
      );
      stepContext = trace.setSpan(scenarioContext, attemptSpan);
    },

    recordStep(action) {
      const host = attemptSpan ?? scenarioSpan;
      const endedAt = Date.parse(action.timestamp);
      const timestamp = Number.isNaN(endedAt) ? Date.now() : endedAt;

      if (action.name === BATCH_TOOL || NON_STEP_TOOLS.has(action.name)) {
        host.addEvent(action.name, stepEventAttributes(action), timestamp);
        return;
      }

      // onAction fires after the tool completes, so the span is back-dated from
      // the duration the harness measured.
      const span = tracer.startSpan(
        action.name,
        {
          kind: SpanKind.INTERNAL,
          startTime: timestamp - action.durationMs,
          attributes: {
            [ATTR_BLOP_STEP_TOOL]: action.name,
            ...stepInputAttributes(action.input),
          },
        },
        stepContext,
      );

      const error = actionError(action);
      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: truncate(error) });
      }
      span.end(timestamp);
    },

    recordResume(resume, max) {
      // A resume has no measurable end boundary at this hook, so it is a
      // timestamped event rather than a span.
      (attemptSpan ?? scenarioSpan).addEvent("blop.agent.resume", {
        "blop.agent.resume.count": resume,
        "blop.agent.resume.max": max,
      });
    },

    end({ status, reason, attempts }) {
      const finishedAt = new Date();
      closeAttempt(finishedAt);

      scenarioSpan.setAttribute(
        ATTR_TEST_CASE_RESULT_STATUS,
        status === "passed" ? TEST_CASE_RESULT_STATUS_VALUE_PASS : TEST_CASE_RESULT_STATUS_VALUE_FAIL,
      );
      scenarioSpan.setAttribute(ATTR_BLOP_SCENARIO_ATTEMPTS, attempts);
      if (status !== "passed") {
        scenarioSpan.setAttribute(ATTR_BLOP_FAILURE_CATEGORY, failureCategory(status, reason));
        scenarioSpan.setStatus({ code: SpanStatusCode.ERROR, message: truncate(reason) });
      }
      scenarioSpan.end(finishedAt);
    },
  };
}

/** The root describe block. `checkout > applies discount` gives `checkout`. */
export function journeyId(testName: string): string {
  const [root] = testName.split(" > ");
  return (root ?? testName).trim() || testName;
}

/**
 * Coarse bucket for why a scenario did not pass, derived from the runner's own
 * failure wording. Kept deliberately small so it stays usable as a metric
 * dimension later.
 */
export function failureCategory(status: BlopTestStatus, reason: string): string {
  if (/timed out/i.test(reason)) return "timeout";
  if (/appears to be stuck/i.test(reason)) return "stall";
  if (/without calling finish_test/i.test(reason)) return "agent_incomplete";
  if (/Failed to (create|load)/i.test(reason)) return "infrastructure";
  return status === "failed" ? "assertion" : "error";
}

function suiteRunStatus(status: BlopTestStatus): string {
  if (status === "passed") return TEST_SUITE_RUN_STATUS_VALUE_SUCCESS;
  if (status === "failed") return TEST_SUITE_RUN_STATUS_VALUE_FAILURE;
  // Blop's "error" means the harness or agent broke, not that the app failed.
  return TEST_SUITE_RUN_STATUS_VALUE_ABORTED;
}

function pipelineResult(status: BlopTestStatus): string {
  if (status === "passed") return CICD_PIPELINE_RESULT_VALUE_SUCCESS;
  if (status === "failed") return CICD_PIPELINE_RESULT_VALUE_FAILURE;
  return CICD_PIPELINE_RESULT_VALUE_ERROR;
}

function agentAttributes(provider?: string | null, model?: string | null): Attributes {
  return {
    ...(provider ? { [ATTR_BLOP_AGENT_PROVIDER]: provider } : {}),
    ...(model ? { [ATTR_BLOP_AGENT_MODEL]: model } : {}),
  };
}

function ciAttributes(ci: BlopCiMetadata): Attributes {
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
 * Only the fields that identify *where* a step acted. Typed text, extracted
 * page content and DOM snapshots are deliberately excluded: spans carry
 * pointers, never payloads, and tool inputs can hold credentials.
 */
function stepInputAttributes(input: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  if (typeof input.url === "string") attributes["blop.step.url"] = truncate(sanitizeUrl(input.url));

  const target = input.target ?? input.ref ?? input.selector;
  if (typeof target === "string") attributes["blop.step.target"] = truncate(target);

  return attributes;
}

function stepEventAttributes(action: BlopAction): Attributes {
  const error = actionError(action);
  return {
    [ATTR_BLOP_STEP_TOOL]: action.name,
    "blop.step.duration_ms": action.durationMs,
    ...(error ? { "blop.step.error": truncate(error) } : {}),
  };
}

function actionError(action: BlopAction): string | null {
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

function truncate(value: string): string {
  return value.length > MAX_ATTRIBUTE_LENGTH ? `${value.slice(0, MAX_ATTRIBUTE_LENGTH)}...` : value;
}

/**
 * Resolve or reject within FLUSH_TIMEOUT_MS, and always clear the timer so a
 * pending handle cannot keep the CLI process alive.
 */
async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${FLUSH_TIMEOUT_MS}ms`)),
      FLUSH_TIMEOUT_MS,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(text: string): void {
  console.error(`[blop:otel] ${text}`);
}
