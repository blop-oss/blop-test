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
  headers: Record<string, string>;
  serviceName: string;
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
  | "otelPropagateToApp"
  | "otelPropagateAllowlist"
>;

const DEFAULT_SERVICE_NAME = "blop-runner";
const TRACES_PATH = "/v1/traces";

export function resolveOtelConfig(
  options: BlopOtelOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): BlopOtelConfig | null {
  const tracesUrl = resolveTracesUrl(options, env);
  if (!tracesUrl) return null;

  return {
    tracesUrl,
    headers: {
      ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
      ...(options.otelHeaders ?? {}),
    },
    serviceName:
      trimmed(options.otelServiceName) ?? trimmed(env.OTEL_SERVICE_NAME) ?? DEFAULT_SERVICE_NAME,
    propagateToApp: options.otelPropagateToApp ?? parseBoolean(env.BLOP_OTEL_PROPAGATE_TO_APP),
    propagateAllowlist:
      options.otelPropagateAllowlist ?? parseHostList(env.BLOP_OTEL_PROPAGATE_ALLOWLIST),
  };
}

/**
 * A CLI flag or config value wins over the environment, matching how every
 * other option in this package resolves. Within the environment, the OTLP spec
 * says the signal-specific endpoint is used verbatim while the generic one has
 * the signal path appended.
 */
function resolveTracesUrl(options: BlopOtelOptions, env: NodeJS.ProcessEnv): string | null {
  const explicit = trimmed(options.otelEndpoint);
  if (explicit) return appendTracesPath(explicit);

  const signal = trimmed(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  if (signal) return signal;

  const generic = trimmed(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (generic) return appendTracesPath(generic);

  return null;
}

function appendTracesPath(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith(TRACES_PATH) ? base : `${base}${TRACES_PATH}`;
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
