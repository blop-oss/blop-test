import type { BlopRunOptions } from "../runtime/types.js";

/**
 * OTLP transport protocol for a signal. Only the HTTP flavours are supported;
 * gRPC is rejected explicitly so a customer who configures it does not silently
 * get JSON exports against a collector that is not listening for them.
 */
export type OtlpProtocol = "http/protobuf" | "http/json";

/**
 * Resolved OpenTelemetry settings for a run.
 *
 * Mirrors the "skipped, not failed" contract of the platform upload boundary:
 * when no endpoint is configured for any signal this resolver returns null and
 * the runner never touches the OTel SDK. Telemetry is opt-in and must never be
 * able to fail a test run.
 *
 * Each signal resolves independently: a run can export traces only, metrics
 * only, logs only, or any combination. `resolve` returns a non-null config as
 * long as at least one signal has somewhere to send data.
 */
export type BlopOtelConfig = {
  /**
   * Full OTLP/HTTP traces URL, e.g. http://collector:4318/v1/traces. Null when
   * no traces endpoint resolved; in that case a tracer is still constructed
   * so log records and trace propagation keep a parent context, but no trace
   * data is exported.
   */
  tracesUrl: string | null;
  /**
   * Null when no endpoint resolves for the signal. The OTLP default would be
   * localhost:4318, so exporting anyway would quietly post a customer's
   * telemetry into the void and log a connection error on every run.
   */
  metricsUrl: string | null;
  logsUrl: string | null;
  /** Per-signal transport protocol. Defaults to http/protobuf. */
  tracesProtocol: OtlpProtocol;
  metricsProtocol: OtlpProtocol;
  logsProtocol: OtlpProtocol;
  /** Standard OTLP timeout per signal, capped below the CLI shutdown budget. */
  tracesTimeoutMs: number;
  metricsTimeoutMs: number;
  logsTimeoutMs: number;
  /** Headers for the traces signal (generic + traces-specific + options). */
  headers: Record<string, string>;
  metricsHeaders: Record<string, string>;
  logsHeaders: Record<string, string>;
  serviceName: string;
  /** deployment.environment.name on the resource. Undefined when unknown. */
  environment?: string;
  /** Inject W3C traceparent into requests the browser makes (Cut 2). */
  propagateToApp: boolean;
  /** Hosts allowed to receive trace context. Empty means propagate to nothing. */
  propagateAllowlist: string[];
};

export type BlopOtelOptions = Pick<
  BlopRunOptions,
  | "otelEndpoint"
  | "otelHeaders"
  | "otelServiceName"
  | "otelEnvironment"
  | "otelPropagateToApp"
  | "otelPropagateAllowlist"
>;

const DEFAULT_SERVICE_NAME = "blop-runner";
const DEFAULT_PROTOCOL: OtlpProtocol = "http/protobuf";
const DEFAULT_EXPORT_TIMEOUT_MS = 10_000;
const MAX_EXPORT_TIMEOUT_MS = 4_500;

const SIGNAL_PATHS = {
  traces: "/v1/traces",
  metrics: "/v1/metrics",
  logs: "/v1/logs",
} as const;

type Signal = keyof typeof SIGNAL_PATHS;

const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set<OtlpProtocol>([
  "http/protobuf",
  "http/json",
]);

/**
 * Resolve OpenTelemetry settings for a run. Returns null when no signal has a
 * configured endpoint. Throws when a signal that has an endpoint is configured
 * with an unsupported (gRPC) protocol, so it is never silently downgraded.
 */
export function resolveOtelConfig(
  options: BlopOtelOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): BlopOtelConfig | null {
  const tracesUrl = resolveSignalUrl("traces", options, env);
  const metricsUrl = resolveSignalUrl("metrics", options, env);
  const logsUrl = resolveSignalUrl("logs", options, env);
  if (!tracesUrl && !metricsUrl && !logsUrl) return null;

  // Protocols are only resolved for signals that actually have an endpoint,
  // so a globally-set gRPC protocol that nothing uses is harmless instead of
  // a hard failure.
  const tracesProtocol = tracesUrl ? resolveSignalProtocol("traces", env) : DEFAULT_PROTOCOL;
  const metricsProtocol = metricsUrl ? resolveSignalProtocol("metrics", env) : DEFAULT_PROTOCOL;
  const logsProtocol = logsUrl ? resolveSignalProtocol("logs", env) : DEFAULT_PROTOCOL;

  return {
    tracesUrl,
    metricsUrl,
    logsUrl,
    tracesProtocol,
    metricsProtocol,
    logsProtocol,
    tracesTimeoutMs: resolveSignalTimeout("traces", env),
    metricsTimeoutMs: resolveSignalTimeout("metrics", env),
    logsTimeoutMs: resolveSignalTimeout("logs", env),
    headers: signalHeaders("traces", options, env),
    metricsHeaders: signalHeaders("metrics", options, env),
    logsHeaders: signalHeaders("logs", options, env),
    // OTEL_SERVICE_NAME is the documented way, but service.name is also legal
    // inside OTEL_RESOURCE_ATTRIBUTES; honour it before falling back.
    serviceName:
      trimmed(options.otelServiceName) ??
      trimmed(env.OTEL_SERVICE_NAME) ??
      resourceAttribute(env.OTEL_RESOURCE_ATTRIBUTES, "service.name") ??
      DEFAULT_SERVICE_NAME,
    environment:
      trimmed(options.otelEnvironment) ??
      resourceAttribute(env.OTEL_RESOURCE_ATTRIBUTES, "deployment.environment.name"),
    propagateToApp: options.otelPropagateToApp ?? parseBoolean(env.BLOP_OTEL_PROPAGATE_TO_APP),
    // Normalised whatever the source, so a host written as "Staging.Example.com"
    // in blop.config.ts still matches: shouldPropagateTo lowercases the request
    // hostname but compares against these entries verbatim. An empty list is
    // indistinguishable from "unset" (both propagate to nothing), so it falls
    // through to the next source rather than silently winning.
    propagateAllowlist:
      firstNonEmpty(
        normalizeHosts(options.otelPropagateAllowlist),
        parseHostList(env.BLOP_OTEL_PROPAGATE_ALLOWLIST),
      ),
  };
}

/**
 * A CLI flag or config value wins over the environment, matching how every
 * other option in this package resolves. Within the environment, the OTLP spec
 * says a signal-specific endpoint is used verbatim while the generic one has
 * the signal path appended.
 */
function resolveSignalUrl(
  signal: Signal,
  options: BlopOtelOptions,
  env: NodeJS.ProcessEnv,
): string | null {
  const explicit = trimmed(options.otelEndpoint);
  if (explicit) return appendSignalPath(explicit, signal);

  const specific = trimmed(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]);
  if (specific) return specific;

  const generic = trimmed(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (generic) return appendSignalPath(generic, signal);

  return null;
}

/**
 * Append the signal's resource path to a generic endpoint, preserving any
 * existing path. The OTLP specification is literal: `${endpoint}/v1/<signal>`,
 * so a base like `http://collector:4318/foo` becomes
 * `http://collector:4318/foo/v1/traces`. We never strip an existing path
 * (including an existing `/v1/traces`), matching the official SDK behaviour and
 * keeping the customer's intent intact.
 */
function appendSignalPath(endpoint: string, signal: Signal): string {
  const base = endpoint.replace(/\/+$/, "");
  return `${base}${SIGNAL_PATHS[signal]}`;
}

/**
 * Resolve the transport protocol for a signal. The signal-specific variable
 * wins over the generic one; both default to http/protobuf per the spec.
 */
function resolveSignalProtocol(signal: Signal, env: NodeJS.ProcessEnv): OtlpProtocol {
  const specific = trimmed(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`]);
  if (specific) return normalizeProtocol(specific, signal);

  const generic = trimmed(env.OTEL_EXPORTER_OTLP_PROTOCOL);
  if (generic) return normalizeProtocol(generic, signal);

  return DEFAULT_PROTOCOL;
}

function normalizeProtocol(value: string, signal: Signal): OtlpProtocol {
  const lower = value.trim().toLowerCase();
  if (SUPPORTED_PROTOCOLS.has(lower as OtlpProtocol)) return lower as OtlpProtocol;
  // gRPC and anything else we do not implement: report it loudly so the
  // caller can decide whether to fail the run or fall back to HTTP itself.
  throw new Error(
    `OpenTelemetry ${signal} protocol "${value}" is not supported by the Blop exporter. ` +
      `Use "http/protobuf" or "http/json" (got "${value}").`,
  );
}

function resolveSignalTimeout(signal: Signal, env: NodeJS.ProcessEnv): number {
  const raw =
    trimmed(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_TIMEOUT`]) ??
    trimmed(env.OTEL_EXPORTER_OTLP_TIMEOUT);
  const parsed = raw ? Number(raw) : DEFAULT_EXPORT_TIMEOUT_MS;
  const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXPORT_TIMEOUT_MS;
  return Math.min(timeout, MAX_EXPORT_TIMEOUT_MS);
}

/** Generic headers, then the signal-specific ones, then explicit options. */
function signalHeaders(
  signal: Signal,
  options: BlopOtelOptions,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseOtlpHeaders(env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]),
    ...(options.otelHeaders ?? {}),
  };
}

/**
 * Parse `OTEL_EXPORTER_OTLP_HEADERS`, a comma-separated list of key=value
 * pairs whose members are percent-encoded per the OTLP specification.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};

  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;

    const key = decodeOrRaw(pair.slice(0, separator).trim());
    const value = decodeOrRaw(pair.slice(separator + 1).trim());
    if (key) headers[key] = value;
  }

  return headers;
}

/**
 * Read one attribute out of `OTEL_RESOURCE_ATTRIBUTES`, which uses the same
 * comma-separated key=value encoding as the headers variable.
 */
export function resourceAttribute(raw: string | undefined, key: string): string | undefined {
  return trimmed(parseOtlpHeaders(raw)[key]);
}

export function parseHostList(raw: string | undefined): string[] {
  return normalizeHosts(raw?.split(","));
}

function firstNonEmpty(...lists: string[][]): string[] {
  return lists.find((list) => list.length > 0) ?? [];
}

export function normalizeHosts(hosts: string[] | undefined): string[] {
  return (hosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean);
}

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function decodeOrRaw(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape must not take the run down; keep the literal text.
    return value;
  }
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}
