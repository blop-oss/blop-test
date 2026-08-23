import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Counter,
  type Histogram,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { SeverityNumber, type AnyValueMap, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  AggregationTemporalityPreference,
  OTLPMetricExporter,
} from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
  type Resource,
} from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { AlwaysOnSampler, BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  ATTR_CICD_PIPELINE_RESULT,
  ATTR_CLOUDEVENTS_EVENT_ID,
  ATTR_CLOUDEVENTS_EVENT_SOURCE,
  ATTR_CLOUDEVENTS_EVENT_SPEC_VERSION,
  ATTR_CLOUDEVENTS_EVENT_SUBJECT,
  ATTR_CLOUDEVENTS_EVENT_TYPE,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_TEST_CASE_NAME,
  ATTR_TEST_CASE_RESULT_STATUS,
  ATTR_TEST_SUITE_NAME,
  ATTR_TEST_SUITE_RUN_STATUS,
  TEST_CASE_RESULT_STATUS_VALUE_FAIL,
  TEST_CASE_RESULT_STATUS_VALUE_PASS,
} from "@opentelemetry/semantic-conventions/incubating";
import type { BlopOtelConfig } from "../node/otel-config.js";
import type { BlopAction, BlopCiMetadata, BlopTestStatus } from "../runtime/types.js";
import {
  actionError,
  agentAttributes,
  ATTR_BLOP_BASE_URL,
  ATTR_BLOP_FAILURE_CATEGORY,
  ATTR_BLOP_JOURNEY_ID,
  ATTR_BLOP_RECOVERY_KIND,
  ATTR_BLOP_RUN_ID,
  ATTR_BLOP_SCENARIO_ATTEMPTS,
  ATTR_BLOP_SCENARIO_PATH,
  ATTR_BLOP_STEP_TOOL,
  ATTR_BLOP_TEAM,
  ATTR_BLOP_TOKEN_KIND,
  ciAttributes,
  failureCategory,
  journeyId,
  NON_STEP_TOOLS,
  pipelineResult,
  sanitizeUrl,
  stepEventAttributes,
  stepInputAttributes,
  suiteRunStatus,
  truncate,
} from "./otel-attributes.js";

export * from "./otel-attributes.js";

const TRACER_NAME = "@blopai/cli";

/**
 * Hard ceiling on how long shutdown may wait for the collector. The OTLP
 * exporter retries with backoff, so an unreachable collector would otherwise
 * add ~8s to every run. Telemetry is allowed to be lost; it is not allowed to
 * slow the suite down.
 */
const FLUSH_TIMEOUT_MS = 5_000;
/** Per-attempt ceiling, so a hung collector cannot consume the whole budget. */
const EXPORT_TIMEOUT_MS = 3_000;
/** Releasing timers and sockets should be near-instant; do not wait on it. */
const SHUTDOWN_TIMEOUT_MS = 1_000;

export type BlopOtelStep = {
  /** Close the step. Pass a message to mark it failed. */
  end(error?: string | null): void;
};

export type BlopOtelScenarioSpan = {
  /** Open a `scenario.retry` span for attempts after the first. */
  beginAttempt(attempt: number): void;
  /**
   * Open a live span before a tool runs. This is what trace propagation
   * injects, and what inner steps of a batching tool nest under.
   */
  beginStep(name: string, toolInput: Record<string, unknown>): BlopOtelStep;
  /** Reconcile the harness's post-completion record with the live span. */
  recordStep(action: BlopAction): void;
  recordResume(resume: number, max: number): void;
  /** Reset per-call token accounting. Usage totals are cumulative per call. */
  beginLlmCall(): void;
  recordTokens(usage: Record<string, unknown>): void;
  /** The context a `traceparent` should reference right now. */
  activeContext(): Context;
  /** Idempotent: the runner also closes the scenario from a finally block. */
  end(input: {
    status: BlopTestStatus;
    reason: string;
    attempts: number;
    durationMs: number;
  }): void;
};

export type BlopOtelRunSpan = {
  startScenario(input: {
    name: string;
    specFile?: string;
    baseUrl?: string | null;
  }): BlopOtelScenarioSpan;
  end(input: { status: BlopTestStatus; finishedAt: Date; durationMs: number }): Promise<void>;
};

export type BlopOtelRunInput = {
  runId: string;
  suiteName: string;
  startedAt: Date;
  ci: BlopCiMetadata;
  provider?: string | null;
  model?: string | null;
  team?: string | null;
  projectId?: string | null;
};

/** Absent when no metrics endpoint resolved; call sites guard with `?.`. */
type Instruments = {
  scenarioDuration?: Histogram;
  recoveries?: Counter;
  tokens?: Counter;
};

export function startOtelRun(config: BlopOtelConfig, input: BlopOtelRunInput): BlopOtelRunSpan {
  const resource = buildResource(config);

  const tracerProvider = new NodeTracerProvider({
    resource,
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

  const meterProvider = config.metricsUrl === null ? null : new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: config.metricsUrl ?? undefined,
          headers: config.metricsHeaders,
          timeoutMillis: EXPORT_TIMEOUT_MS,
          // A CLI run is a short-lived process. Cumulative temporality would
          // restart every series at zero on each run and strand the previous
          // one, so delta is the correct choice for an ephemeral producer.
          temporalityPreference: AggregationTemporalityPreference.DELTA,
        }),
        // The run is far shorter than any sane interval; the flush at shutdown
        // is what actually exports.
        exportIntervalMillis: 60_000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });

  const loggerProvider = config.logsUrl === null ? null : new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: config.logsUrl ?? undefined,
          headers: config.logsHeaders,
          timeoutMillis: EXPORT_TIMEOUT_MS,
        }),
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });

  // Deliberately not registered as global providers. Scenarios interleave on
  // one event loop under --workers, so every parent context is threaded
  // explicitly and an ambient active-span stack would cross-link them.
  const tracer = tracerProvider.getTracer(TRACER_NAME);
  const meter = meterProvider?.getMeter(TRACER_NAME);

  const instruments: Instruments = {
    scenarioDuration: meter?.createHistogram("blop.scenario.duration", {
      description: "How long a scenario took, including retries.",
      // Semantic conventions require seconds for duration instruments.
      unit: "s",
    }),
    recoveries: meter?.createCounter("blop.agent.recoveries", {
      description: "Times the runner recovered a scenario by resuming the agent or retrying it.",
      unit: "{recovery}",
    }),
    tokens: meter?.createCounter("blop.agent.tokens", {
      description: "Model tokens consumed while running scenarios.",
      unit: "{token}",
    }),
  };

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

  const logger = loggerProvider?.getLogger(TRACER_NAME);
  const cloudEvent: CloudEventEmitter = logger
    ? createCloudEventEmitter(logger, input)
    : () => {};

  // A scenario can be abandoned if the runner throws outside a guarded region
  // (creating a page, starting the screencast). An unended span is never
  // exported, which would lose the trace for exactly the failures worth
  // seeing, so the run closes anything still open.
  const openScenarios = new Set<{ abandon: () => void }>();
  cloudEvent("qa.run.started.v1", runContext, {
    run_id: input.runId,
    ...(input.projectId ? { project_id: input.projectId } : {}),
  });

  return {
    startScenario: (scenario) => {
      const started = startScenario({ tracer, runContext, instruments, cloudEvent, input, scenario });
      const entry = { abandon: started.abandon };
      openScenarios.add(entry);
      started.onEnd(() => openScenarios.delete(entry));
      return started.span;
    },

    end: async ({ status, finishedAt, durationMs }) => {
      for (const scenario of [...openScenarios]) scenario.abandon();
      openScenarios.clear();

      runSpan.setAttribute(ATTR_TEST_SUITE_RUN_STATUS, suiteRunStatus(status));
      if (input.ci.provider) {
        runSpan.setAttribute(ATTR_CICD_PIPELINE_RESULT, pipelineResult(status));
      }
      if (status !== "passed") runSpan.setStatus({ code: SpanStatusCode.ERROR });

      cloudEvent("qa.run.finished.v1", runContext, {
        run_id: input.runId,
        ...(input.projectId ? { project_id: input.projectId } : {}),
        status,
        duration_ms: durationMs,
      });
      runSpan.end(finishedAt);

      // Must complete here: the CLI calls process.exit right after its summary
      // prints, which would drop anything still buffered.
      await shutdown(tracerProvider, meterProvider, loggerProvider);
    },
  };
}

/**
 * `defaultResource()` does not read `OTEL_RESOURCE_ATTRIBUTES`, so the standard
 * variable would silently do nothing. Detect it explicitly, then let resolved
 * config win over it.
 */
function buildResource(config: BlopOtelConfig): Resource {
  const detected = defaultResource().merge(detectResources({ detectors: [envDetector] }));

  return detected.merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.environment ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment } : {}),
    }),
  );
}

type CloudEventEmitter = (type: string, context: Context, data: AnyValueMap) => void;

/**
 * Mirror the existing CloudEvent taxonomy onto OTel log records carrying trace
 * context. A second transport for the taxonomy the platform already speaks,
 * not a new one, so the type strings stay identical.
 */
function createCloudEventEmitter(logger: Logger, input: BlopOtelRunInput): CloudEventEmitter {
  const source = `urn:blop:runner:cli:${input.runId}`;
  let sequence = 0;

  return (type, context, data) => {
    sequence += 1;
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: data,
      context,
      attributes: {
        [ATTR_CLOUDEVENTS_EVENT_TYPE]: type,
        [ATTR_CLOUDEVENTS_EVENT_ID]: `${input.runId}-${sequence}`,
        [ATTR_CLOUDEVENTS_EVENT_SOURCE]: source,
        [ATTR_CLOUDEVENTS_EVENT_SUBJECT]: input.runId,
        [ATTR_CLOUDEVENTS_EVENT_SPEC_VERSION]: "1.0",
      },
    });
  };
}

function startScenario(args: {
  tracer: Tracer;
  runContext: Context;
  instruments: Instruments;
  cloudEvent: CloudEventEmitter;
  input: BlopOtelRunInput;
  scenario: { name: string; specFile?: string; baseUrl?: string | null };
}): { span: BlopOtelScenarioSpan; abandon: () => void; onEnd: (fn: () => void) => void } {
  const { tracer, runContext, instruments, cloudEvent, input, scenario } = args;
  const journey = journeyId(scenario.name);

  const scenarioSpan = tracer.startSpan(
    scenario.name,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_TEST_CASE_NAME]: scenario.name,
        [ATTR_BLOP_JOURNEY_ID]: journey,
        ...(scenario.specFile ? { [ATTR_BLOP_SCENARIO_PATH]: scenario.specFile } : {}),
        ...(scenario.baseUrl ? { [ATTR_BLOP_BASE_URL]: sanitizeUrl(scenario.baseUrl) } : {}),
      },
    },
    runContext,
  );
  const scenarioContext = trace.setSpan(runContext, scenarioSpan);

  // Attempt 1 hangs its steps directly off the scenario so the common trace is
  // exactly run > scenario > step. A retry is the exception, so it earns a span.
  let attemptSpan: Span | null = null;
  let attemptContext = scenarioContext;

  // The live span for the tool currently executing. Inner steps of a batching
  // tool arrive while it is open and nest under it.
  let openStep: { span: Span; context: Context; name: string; consumed: boolean } | null = null;
  let ended = false;
  // Token totals already counted for the LLM call in flight.
  let countedTokens: Record<string, number> = {};

  let onEnded: () => void = () => {};
  const host = () => attemptSpan ?? scenarioSpan;
  const hostContext = () => openStep?.context ?? attemptContext;

  const closeAttempt = (endTime?: Date) => {
    if (!attemptSpan) return;
    attemptSpan.end(endTime);
    attemptSpan = null;
    attemptContext = scenarioContext;
  };

  const span: BlopOtelScenarioSpan = {
    beginAttempt(attempt) {
      closeAttempt();
      if (attempt < 2) return;

      instruments.recoveries?.add(1, {
        [ATTR_BLOP_JOURNEY_ID]: journey,
        [ATTR_BLOP_RECOVERY_KIND]: "retry",
      });
      attemptSpan = tracer.startSpan(
        "scenario.retry",
        { kind: SpanKind.INTERNAL, attributes: { [ATTR_BLOP_SCENARIO_ATTEMPTS]: attempt } },
        scenarioContext,
      );
      attemptContext = trace.setSpan(scenarioContext, attemptSpan);
    },

    beginStep(name, toolInput) {
      // Bookkeeping tools are events, not steps; keep them off the live stack.
      if (NON_STEP_TOOLS.has(name)) return { end: () => {} };

      const span = tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          attributes: { [ATTR_BLOP_STEP_TOOL]: name, ...stepInputAttributes(toolInput) },
        },
        attemptContext,
      );
      const step = { span, context: trace.setSpan(attemptContext, span), name, consumed: false };
      openStep = step;

      return {
        end(error) {
          if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: truncate(error) });
          span.end();
          if (openStep === step) openStep = null;
        },
      };
    },

    recordStep(action) {
      const endedAt = Date.parse(action.timestamp);
      const timestamp = Number.isNaN(endedAt) ? Date.now() : endedAt;
      const error = actionError(action);

      if (NON_STEP_TOOLS.has(action.name)) {
        host().addEvent(action.name, stepEventAttributes(action), timestamp);
        return;
      }

      // The harness's record for the tool we already opened live: enrich that
      // span rather than emitting a duplicate.
      if (openStep && !openStep.consumed && openStep.name === action.name) {
        openStep.consumed = true;
        for (const [key, value] of Object.entries(stepInputAttributes(action.input))) {
          if (value !== undefined) openStep.span.setAttribute(key, value);
        }
        if (error) openStep.span.setStatus({ code: SpanStatusCode.ERROR, message: truncate(error) });
        return;
      }

      // An inner step of a batching tool, or an action with no live span.
      // onAction fires after completion, so back-date by the measured duration.
      const span = tracer.startSpan(
        action.name,
        {
          kind: SpanKind.INTERNAL,
          startTime: timestamp - action.durationMs,
          attributes: { [ATTR_BLOP_STEP_TOOL]: action.name, ...stepInputAttributes(action.input) },
        },
        hostContext(),
      );
      if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: truncate(error) });
      span.end(timestamp);
    },

    recordResume(resume, max) {
      instruments.recoveries?.add(1, {
        [ATTR_BLOP_JOURNEY_ID]: journey,
        [ATTR_BLOP_RECOVERY_KIND]: "resume",
      });
      // A resume has no measurable end boundary at this hook, so it is a
      // timestamped event rather than a span.
      host().addEvent("blop.agent.resume", {
        "blop.agent.resume.count": resume,
        "blop.agent.resume.max": max,
      });
    },

    beginLlmCall() {
      countedTokens = {};
    },

    recordTokens(usage) {
      for (const kind of ["input", "output", "cache_read", "cache_write"] as const) {
        const total = usage[kind];
        if (typeof total !== "number" || !Number.isFinite(total) || total < 0) continue;

        // prompt_tokens and completion_tokens are running totals for the whole
        // request, and the agent loop re-emits a usage event for every chunk
        // that carries one. Adding each event would multiply the count by the
        // number of chunks, so only the increase since the last one is counted.
        const already = countedTokens[kind] ?? 0;
        const delta = total - already;
        countedTokens[kind] = Math.max(total, already);
        if (delta <= 0) continue;

        instruments.tokens?.add(delta, {
          [ATTR_BLOP_JOURNEY_ID]: journey,
          [ATTR_BLOP_TOKEN_KIND]: kind,
          ...(input.team ? { [ATTR_BLOP_TEAM]: input.team } : {}),
        });
      }
    },

    activeContext: () => hostContext(),

    end({ status, reason, attempts, durationMs }) {
      if (ended) return;
      ended = true;

      const finishedAt = new Date();
      if (openStep) {
        openStep.span.end();
        openStep = null;
      }
      closeAttempt(finishedAt);

      const resultStatus =
        status === "passed" ? TEST_CASE_RESULT_STATUS_VALUE_PASS : TEST_CASE_RESULT_STATUS_VALUE_FAIL;
      scenarioSpan.setAttribute(ATTR_TEST_CASE_RESULT_STATUS, resultStatus);
      scenarioSpan.setAttribute(ATTR_BLOP_SCENARIO_ATTEMPTS, attempts);

      const category = status === "passed" ? null : failureCategory(status, reason);
      if (category) {
        scenarioSpan.setAttribute(ATTR_BLOP_FAILURE_CATEGORY, category);
        scenarioSpan.setStatus({ code: SpanStatusCode.ERROR, message: truncate(reason) });
      }

      // Seconds, per the metric semantic conventions. The histogram's own count
      // already gives scenario results per journey and status, so a separate
      // results counter would be pure duplication.
      instruments.scenarioDuration?.record(durationMs / 1000, {
        [ATTR_BLOP_JOURNEY_ID]: journey,
        [ATTR_TEST_CASE_RESULT_STATUS]: resultStatus,
        ...(category ? { [ATTR_BLOP_FAILURE_CATEGORY]: category } : {}),
      });

      cloudEvent("qa.run.step.finished.v1", scenarioContext, {
        run_id: input.runId,
        ...(input.projectId ? { project_id: input.projectId } : {}),
        name: scenario.name,
        status,
        duration_ms: durationMs,
      });

      scenarioSpan.end(finishedAt);
      onEnded();
    },
  };

  /**
   * Close a scenario the runner never finished. Deliberately silent on metrics
   * and events: an abandoned scenario has no meaningful duration, and a
   * zero-second data point would skew the histogram.
   */
  const abandon = () => {
    if (ended) return;
    ended = true;

    const finishedAt = new Date();
    openStep?.span.end(finishedAt);
    openStep = null;
    closeAttempt(finishedAt);

    scenarioSpan.setAttribute(ATTR_TEST_CASE_RESULT_STATUS, TEST_CASE_RESULT_STATUS_VALUE_FAIL);
    scenarioSpan.setAttribute(ATTR_BLOP_FAILURE_CATEGORY, "abandoned");
    scenarioSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: "The run ended before this scenario finished.",
    });
    scenarioSpan.end(finishedAt);
    onEnded();
  };

  return {
    span,
    abandon,
    onEnd: (fn) => {
      onEnded = fn;
    },
  };
}

async function shutdown(
  tracerProvider: NodeTracerProvider,
  meterProvider: MeterProvider | null,
  loggerProvider: LoggerProvider | null,
): Promise<void> {
  const providers: Array<[string, { forceFlush(): Promise<void>; shutdown(): Promise<void> }]> = [
    ["traces", tracerProvider],
    ...(meterProvider ? [["metrics", meterProvider] as [string, MeterProvider]] : []),
    ...(loggerProvider ? [["logs", loggerProvider] as [string, LoggerProvider]] : []),
  ];

  // One shared budget, flushed concurrently. A per-signal timeout would let an
  // unreachable collector stall shutdown once per signal.
  const flushed = await settleWithin(
    providers.map(([, provider]) => provider.forceFlush()),
    FLUSH_TIMEOUT_MS,
  );

  flushed.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      warn(`Failed to flush OpenTelemetry ${providers[index]![0]}: ${message(outcome.reason)}`);
    }
  });

  // Failures are already reported; shutdown just releases timers and sockets.
  await settleWithin(
    providers.map(([, provider]) => provider.shutdown()),
    SHUTDOWN_TIMEOUT_MS,
  );
}

type Outcome = { status: "fulfilled" } | { status: "rejected"; reason: unknown };

/**
 * Settle every promise, but give up on the lot after `budgetMs`. Anything still
 * pending is reported as rejected so the caller can warn once and move on.
 */
async function settleWithin(promises: Promise<unknown>[], budgetMs: number): Promise<Outcome[]> {
  const outcomes: Outcome[] = promises.map(() => ({
    status: "rejected",
    reason: new Error(`timed out after ${budgetMs}ms`),
  }));

  const tracked = promises.map((promise, index) =>
    promise.then(
      () => {
        outcomes[index] = { status: "fulfilled" };
      },
      (reason: unknown) => {
        outcomes[index] = { status: "rejected", reason };
      },
    ),
  );

  try {
    await withTimeout(Promise.all(tracked), "flush", budgetMs);
  } catch {
    // Whatever did not settle keeps its pre-seeded timeout outcome.
  }

  return outcomes;
}

/**
 * Resolve or reject within FLUSH_TIMEOUT_MS, and always clear the timer so a
 * pending handle cannot keep the CLI process alive.
 */
async function withTimeout<T>(promise: Promise<T>, label: string, budgetMs = FLUSH_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${budgetMs}ms`)), budgetMs);
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
