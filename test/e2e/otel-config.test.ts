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

  test("falls back to the absolute path when the spec sits outside the working directory", () => {
    expect(scenarioPathFor("/elsewhere/checkout.blop.ts", "/repo")).toBe("/elsewhere/checkout.blop.ts");
  });

  test("passes through an absent spec file", () => {
    expect(scenarioPathFor(undefined, "/repo")).toBeUndefined();
  });
});
