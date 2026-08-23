import { describe, expect, test } from "bun:test";
import { shouldPropagateTo } from "../../src/runtime/otel-propagation";

describe("propagation allowlist", () => {
  test("matches an exact host and its subdomains", () => {
    expect(shouldPropagateTo("staging.example.com", ["staging.example.com"])).toBe(true);
    expect(shouldPropagateTo("api.staging.example.com", ["staging.example.com"])).toBe(true);
    expect(shouldPropagateTo("STAGING.EXAMPLE.COM", ["staging.example.com"])).toBe(true);
  });

  test("rejects a parent domain of an allowlisted host", () => {
    expect(shouldPropagateTo("example.com", ["staging.example.com"])).toBe(false);
  });

  test("rejects a lookalike that a substring match would accept", () => {
    // The harness's third-party classifier uses host.includes(pattern), which
    // would accept all of these. As a gate on where trace context is sent it
    // has to be exact-host-or-dot-suffix.
    expect(shouldPropagateTo("evil-sentry.iomalicious.com", ["sentry.io"])).toBe(false);
    expect(shouldPropagateTo("staging.example.com.attacker.net", ["staging.example.com"])).toBe(false);
    expect(shouldPropagateTo("notstaging.example.com", ["notstaging.example.co"])).toBe(false);
  });

  test("propagates to nothing when the allowlist is empty", () => {
    expect(shouldPropagateTo("staging.example.com", [])).toBe(false);
    expect(shouldPropagateTo("", ["staging.example.com"])).toBe(false);
  });
});

