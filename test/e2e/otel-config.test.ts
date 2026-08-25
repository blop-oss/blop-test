import { describe, expect, test } from "bun:test";
import { parseHostList, parseOtlpHeaders, resolveOtelConfig } from "../../src/node/otel-config";
import { scenarioPathFor } from "../../src/runtime/runner";

describe("otel config", () => {
  test("is skipped, not failed, when no collector is configured", () => {
    expect(resolveOtelConfig({}, {})).toBeNull();
    expect(resolveOtelConfig({ otelServiceName: "blop-runner" }, {})).toBeNull();
    // A blank endpoint is the same as an absent one.
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBeNull();
  });

  test("appends the signal path to the generic endpoint but not the specific one", () => {
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })?.tracesUrl)
      .toBe("http://collector:4318/v1/traces");
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })?.tracesUrl)
      .toBe("http://collector:4318/v1/traces");
    expect(
      resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/custom" })
        ?.tracesUrl,
    ).toBe("http://collector:4318/custom");
  });

  test("a generic endpoint with a custom path preserves it and appends the signal path", () => {
    // The OTLP spec is literal: `${endpoint}/v1/<signal>`. An existing path is
    // preserved verbatim and never stripped, matching the official SDK.
    expect(
      resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/collector" })
        ?.tracesUrl,
    ).toBe("http://collector:4318/collector/v1/traces");
    expect(
      resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/collector/" })
        ?.metricsUrl,
    ).toBe("http://collector:4318/collector/v1/metrics");
  });

  test("a generic base never strips an existing signal path", () => {
    // A base that already carries a signal path keeps it and appends again,
    // exactly as the official exporter does. The customer must use the
    // per-signal variable to pin a verbatim endpoint.
    const config = resolveOtelConfig({ otelEndpoint: "http://collector:4318/v1/traces" }, {});

    expect(config?.tracesUrl).toBe("http://collector:4318/v1/traces/v1/traces");
    expect(config?.metricsUrl).toBe("http://collector:4318/v1/traces/v1/metrics");
    expect(config?.logsUrl).toBe("http://collector:4318/v1/traces/v1/logs");
  });

  test("a flag or config value beats the environment", () => {
    const config = resolveOtelConfig(
      { otelEndpoint: "http://flag:4318", otelServiceName: "from-flag" },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://env:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://env:4318/v1/traces",
        OTEL_SERVICE_NAME: "from-env",
      },
    );

    expect(config?.tracesUrl).toBe("http://flag:4318/v1/traces");
    expect(config?.serviceName).toBe("from-flag");
  });

  test("defaults the service name", () => {
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" })?.serviceName)
      .toBe("blop-runner");
    expect(
      resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SERVICE_NAME: "web" })
        ?.serviceName,
    ).toBe("web");
  });

  test("parses OTLP headers, including percent-encoded values", () => {
    expect(parseOtlpHeaders("authorization=Bearer abc,x-tenant=acme")).toEqual({
      authorization: "Bearer abc",
      "x-tenant": "acme",
    });
    expect(parseOtlpHeaders("authorization=Bearer%20abc")).toEqual({ authorization: "Bearer abc" });
    // A value may legitimately contain "=" (base64 padding).
    expect(parseOtlpHeaders("authorization=Basic dXNlcjpwYXNz==")).toEqual({
      authorization: "Basic dXNlcjpwYXNz==",
    });
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("garbage")).toEqual({});
  });

  test("signal-specific headers and explicit options layer over the generic ones", () => {
    const config = resolveOtelConfig(
      { otelHeaders: { "x-source": "flag" } },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=generic,x-source=generic",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-source=traces",
      },
    );

    expect(config?.headers).toEqual({ authorization: "generic", "x-source": "flag" });
  });

  test("propagation is off by default and its allowlist is empty", () => {
    const config = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" });
    expect(config?.propagateToApp).toBe(false);
    expect(config?.propagateAllowlist).toEqual([]);
  });

  test("reads propagation settings from the environment", () => {
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        BLOP_OTEL_PROPAGATE_TO_APP: "true",
        BLOP_OTEL_PROPAGATE_ALLOWLIST: "staging.example.com, API.Staging.Example.com",
      },
    );

    expect(config?.propagateToApp).toBe(true);
    expect(config?.propagateAllowlist).toEqual(["staging.example.com", "api.staging.example.com"]);
  });

  test("only unambiguous truthy values enable propagation", () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" };
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(resolveOtelConfig({}, { ...base, BLOP_OTEL_PROPAGATE_TO_APP: value })?.propagateToApp).toBe(true);
    }
    for (const value of ["0", "false", "no", "off", ""]) {
      expect(resolveOtelConfig({}, { ...base, BLOP_OTEL_PROPAGATE_TO_APP: value })?.propagateToApp).toBe(false);
    }
  });

  test("resolves an endpoint per signal", () => {
    const config = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
    expect(config?.tracesUrl).toBe("http://collector:4318/v1/traces");
    expect(config?.metricsUrl).toBe("http://collector:4318/v1/metrics");
    expect(config?.logsUrl).toBe("http://collector:4318/v1/logs");
  });

  test("honours signal-specific endpoints verbatim", () => {
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://generic:4318",
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://metrics:4318/custom",
      },
    );
    expect(config?.tracesUrl).toBe("http://generic:4318/v1/traces");
    expect(config?.metricsUrl).toBe("http://metrics:4318/custom");
  });

  test("layers signal-specific headers per signal", () => {
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=shared",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-stream=logs",
      },
    );
    expect(config?.headers).toEqual({ authorization: "shared" });
    expect(config?.logsHeaders).toEqual({ authorization: "shared", "x-stream": "logs" });
  });

  test("reads the environment from OTEL_RESOURCE_ATTRIBUTES", () => {
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=staging,service.version=1.2.3",
      },
    );
    expect(config?.environment).toBe("staging");
  });

  test("a flag beats OTEL_RESOURCE_ATTRIBUTES for the environment", () => {
    const config = resolveOtelConfig(
      { otelEnvironment: "preview" },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=staging",
      },
    );
    expect(config?.environment).toBe("preview");
  });

  test("falls back to service.name inside OTEL_RESOURCE_ATTRIBUTES", () => {
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_RESOURCE_ATTRIBUTES: "service.name=storefront-qa",
      },
    );
    expect(config?.serviceName).toBe("storefront-qa");
  });

  test("leaves a signal unconfigured rather than defaulting it to localhost", () => {
    // Only a traces endpoint: metrics and logs have nowhere to go. The OTLP
    // default is localhost:4318, which would quietly post a customer's
    // telemetry into the void and log ECONNREFUSED on every run.
    const config = resolveOtelConfig(
      {},
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" },
    );

    expect(config?.tracesUrl).toBe("http://collector:4318/v1/traces");
    expect(config?.metricsUrl).toBeNull();
    expect(config?.logsUrl).toBeNull();
  });

  test("returns a non-null config when any one signal resolves an endpoint", () => {
    // Traces, metrics and logs can each be enabled independently. The run
    // gets telemetry as long as at least one signal has somewhere to go.
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://c:4318/v1/metrics" }))
      .not.toBeNull();
    expect(resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://c:4318/v1/logs" }))
      .not.toBeNull();
  });

  test("defaults every signal protocol to http/protobuf", () => {
    const config = resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" });
    expect(config?.tracesProtocol).toBe("http/protobuf");
    expect(config?.metricsProtocol).toBe("http/protobuf");
    expect(config?.logsProtocol).toBe("http/protobuf");
  });

  test("reads the generic protocol and applies it to every signal", () => {
    const config = resolveOtelConfig(
      {},
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" },
    );
    expect(config?.tracesProtocol).toBe("http/json");
    expect(config?.metricsProtocol).toBe("http/json");
    expect(config?.logsProtocol).toBe("http/json");
  });

  test("a signal-specific protocol beats the generic one", () => {
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      },
    );
    expect(config?.tracesProtocol).toBe("http/protobuf");
    expect(config?.metricsProtocol).toBe("http/json");
    expect(config?.logsProtocol).toBe("http/json");
  });

  test("honours standard timeouts per signal within the CLI shutdown budget", () => {
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
        OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: "1200",
      },
    );
    expect(config?.tracesTimeoutMs).toBe(2500);
    expect(config?.metricsTimeoutMs).toBe(2500);
    expect(config?.logsTimeoutMs).toBe(1200);

    const capped = resolveOtelConfig(
      {},
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_EXPORTER_OTLP_TIMEOUT: "30000" },
    );
    expect(capped?.tracesTimeoutMs).toBe(4500);
  });

  test("rejects an unsupported gRPC protocol for a configured signal rather than silently using JSON", () => {
    expect(() =>
      resolveOtelConfig(
        {},
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
      ),
    ).toThrow(/not supported/);
    // A signal-specific grpc protocol is also rejected.
    expect(() =>
      resolveOtelConfig(
        {},
        {
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://c:4318/v1/metrics",
          OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc",
        },
      ),
    ).toThrow(/not supported/);
  });

  test("ignores an unsupported protocol for a signal that has no endpoint", () => {
    // Only traces has an endpoint and pins http/protobuf; metrics and logs
    // have nowhere to send, so the generic grpc protocol is never validated
    // for them and the run is not rejected.
    const config = resolveOtelConfig(
      {},
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c:4318/v1/traces",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      },
    );
    expect(config?.tracesProtocol).toBe("http/protobuf");
    // metrics/logs have no endpoint, so their protocol defaults even though
    // the generic env var says grpc.
    expect(config?.metricsProtocol).toBe("http/protobuf");
    expect(config?.logsProtocol).toBe("http/protobuf");
  });

  test("does not stack signal paths when the endpoint already carries one", () => {
    // The per-signal endpoint is used verbatim, so a customer pins an exact
    // traces URL with OTEL_EXPORTER_OTLP_TRACES_ENDPOINT rather than the
    // generic one.
    const config = resolveOtelConfig(
      {},
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" },
    );

    expect(config?.tracesUrl).toBe("http://collector:4318/v1/traces");
    // The generic endpoint is not set, so the other signals have no endpoint.
    expect(config?.metricsUrl).toBeNull();
    expect(config?.logsUrl).toBeNull();
  });

  test("normalises an allowlist however it was supplied", () => {
    // The CLI path normalises on the way in; a blop.config.ts value did not,
    // so odd casing silently matched nothing.
    const config = resolveOtelConfig(
      { otelPropagateAllowlist: [" Staging.Example.com ", "", "API.example.com"] },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318" },
    );

    expect(config?.propagateAllowlist).toEqual(["staging.example.com", "api.example.com"]);
  });

  test("an empty allowlist falls through instead of disabling propagation", () => {
    const config = resolveOtelConfig(
      { otelPropagateAllowlist: [] },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318",
        BLOP_OTEL_PROPAGATE_ALLOWLIST: "staging.example.com",
      },
    );

    expect(config?.propagateAllowlist).toEqual(["staging.example.com"]);
  });

  test("parses host lists", () => {
    expect(parseHostList("a.com,b.com")).toEqual(["a.com", "b.com"]);
    expect(parseHostList(" A.com , ,b.com ")).toEqual(["a.com", "b.com"]);
    expect(parseHostList(undefined)).toEqual([]);
  });
});

describe("scenario path", () => {
  test("is reported relative to the working directory", () => {
    expect(scenarioPathFor("/repo/tests/checkout.blop.ts", "/repo")).toBe("tests/checkout.blop.ts");
    expect(scenarioPathFor("/repo/checkout.blop.ts", "/repo")).toBe("checkout.blop.ts");
  });

  test("falls back to a basename rather than leaking an absolute path", () => {
    expect(scenarioPathFor("/outside/private/checkout.blop.ts", "/repo")).toBe("checkout.blop.ts");
  });


  test("passes through an absent spec file", () => {
    expect(scenarioPathFor(undefined, "/repo")).toBeUndefined();
  });
});
