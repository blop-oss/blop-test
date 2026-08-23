import type { BlopRunOptions } from "../runtime/types.js";

/**
 * Resolved OpenTelemetry settings for a run.
 *
 * Mirrors the "skipped, not failed" contract of the platform upload boundary:
 * when no endpoint is configured this resolver returns null and the runner
 * never touches the OTel SDK. Telemetry is opt-in and must never be able to
 * fail a test run.
 */
export type BlopOtelConfig = {
  /** Full OTLP/HTTP traces URL, e.g. http://collector:4318/v1/traces */
  tracesUrl: string;
  metricsUrl: string;
  logsUrl: string;
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

const SIGNAL_PATHS = {
  traces: "/v1/traces",
  metrics: "/v1/metrics",
  logs: "/v1/logs",
} as const;

type Signal = keyof typeof SIGNAL_PATHS;

export function resolveOtelConfig(
  options: BlopOtelOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): BlopOtelConfig | null {
  const tracesUrl = resolveSignalUrl("traces", options, env);
  if (!tracesUrl) return null;

  return {
    tracesUrl,
    metricsUrl: resolveSignalUrl("metrics", options, env)!,
    logsUrl: resolveSignalUrl("logs", options, env)!,
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
    propagateAllowlist:
      options.otelPropagateAllowlist ?? parseHostList(env.BLOP_OTEL_PROPAGATE_ALLOWLIST),
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

function appendSignalPath(endpoint: string, signal: Signal): string {
  const path = SIGNAL_PATHS[signal];
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith(path) ? base : `${base}${path}`;
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
  if (!raw) return [];

  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
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
