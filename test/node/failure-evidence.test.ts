import { describe, it, expect } from "bun:test";
import { signalsFromTestResult } from "../../src/reporters/failure-evidence";

const log = (over: Record<string, unknown>) =>
  ({
    type: "console",
    message: "",
    timestamp: "2026-08-31T12:00:10.000Z",
    ...over,
  }) as never;

const base = {
  status: "failed" as const,
  reason: "",
  attempts: 1,
  firstAttemptStatus: null,
  baseUrl: "https://app.example.com",
  browserLogs: [],
  actions: [],
  startedAt: "2026-08-31T12:00:00.000Z",
  finishedAt: "2026-08-31T12:00:30.000Z",
};

describe("signalsFromTestResult", () => {
  it("splits a failed request by origin", () => {
    // A failing third-party beacon is not an outage; a failing request to the
    // app's own origin is the network-race signal. Only the app-origin one is
    // allowed anywhere near the infrastructure gate.
    const out = signalsFromTestResult({
      ...base,
      browserLogs: [
        log({ type: "requestfailed", message: "net::ERR_ABORTED", url: "https://app.example.com/api/cart" }),
        log({ type: "requestfailed", message: "net::ERR_ABORTED", url: "https://cdn.analytics.io/t.gif" }),
      ],
    });
    expect(out.signals).toContain("request_failed_app_origin");
    expect(out.signals).toContain("request_failed_third_party");
  });

  it("gates on a refused connection only when it is the app's own origin", () => {
    const app = signalsFromTestResult({
      ...base,
      browserLogs: [
        log({ type: "requestfailed", message: "net::ERR_CONNECTION_REFUSED", url: "https://app.example.com/" }),
      ],
    });
    expect(app.signals).toContain("connection_refused");

    const third = signalsFromTestResult({
      ...base,
      browserLogs: [
        log({ type: "requestfailed", message: "net::ERR_CONNECTION_REFUSED", url: "https://cdn.analytics.io/t.gif" }),
      ],
    });
    expect(third.signals).not.toContain("connection_refused");
    expect(third.signals).toContain("request_failed_third_party");
  });

  it("reads an uncaught page error as regression evidence", () => {
    const out = signalsFromTestResult({
      ...base,
      browserLogs: [
        log({ type: "pageerror", message: "Cannot read properties of undefined", level: "attempt:1" }),
      ],
    });
    expect(out.signals).toContain("page_error");
  });

  it("reads HTTP status wording out of console errors", () => {
    const out = signalsFromTestResult({
      ...base,
      browserLogs: [
        log({ level: "error", message: "Failed to load resource: the server responded with a status of 500" }),
      ],
    });
    expect(out.signals).toContain("http_5xx");
  });

  it("never reads a pageerror's level as a console severity", () => {
    // `level` is overloaded: console severity on console logs, `attempt:N` on
    // pageerror and requestfailed (runner.ts:930-945). Reading it without
    // checking `type` first is the single most likely misreading in this file.
    const out = signalsFromTestResult({
      ...base,
      browserLogs: [
        log({ type: "pageerror", level: "error", message: "the server responded with a status of 500" }),
      ],
    });
    expect(out.signals).toContain("page_error");
    expect(out.signals).not.toContain("http_5xx");
  });

  it("names the failing tool and derives its signal", () => {
    const out = signalsFromTestResult({
      ...base,
      actions: [
        { name: "browser_goto", input: {}, output: "ok", timestamp: "2026-08-31T12:00:05.000Z", durationMs: 1 },
        {
          name: "browser_expect_count",
          input: {},
          output: "",
          metadata: { error: "expected 0, got 3" },
          timestamp: "2026-08-31T12:00:10.000Z",
          durationMs: 1,
        },
      ] as never,
    });
    expect(out.failingTool).toBe("browser_expect_count");
    expect(out.signals).toContain("expect_count_mismatch");
  });

  it("never names a bookkeeping tool as the failing step", () => {
    // finish_test and record_critical_point are not steps (otel-attributes.ts:40).
    const out = signalsFromTestResult({
      ...base,
      actions: [
        {
          name: "browser_click",
          input: {},
          output: "",
          metadata: { error: "timed out" },
          timestamp: "2026-08-31T12:00:10.000Z",
          durationMs: 1,
        },
        { name: "finish_test", input: {}, output: "", timestamp: "2026-08-31T12:00:11.000Z", durationMs: 1 },
      ] as never,
    });
    expect(out.failingTool).toBe("browser_click");
    expect(out.signals).toContain("interaction_timeout");
  });

  it("reads a failure that survived every retry as regression evidence", () => {
    const stuck = signalsFromTestResult({ ...base, status: "failed", attempts: 3, firstAttemptStatus: "failed" });
    expect(stuck.signals).toContain("deterministic_failure");
  });

  it("ignores console noise from far outside the failing step", () => {
    // A staging environment that always 500s an analytics beacon would
    // otherwise push every failure in that project toward one class -
    // deterministic, and consistently wrong for that project, which is exactly
    // what "the same root cause lands in the same class" forbids.
    const out = signalsFromTestResult({
      ...base,
      actions: [
        {
          name: "browser_click",
          input: {},
          output: "",
          metadata: { error: "timed out" },
          timestamp: "2026-08-31T12:00:25.000Z",
          durationMs: 2000,
        },
      ] as never,
      browserLogs: [
        log({
          level: "error",
          message: "the server responded with a status of 500",
          timestamp: "2026-08-31T12:00:01.000Z",
        }),
      ],
    });
    expect(out.signals).not.toContain("http_5xx");
  });

  it("keeps console noise that landed while the failing step was running", () => {
    const out = signalsFromTestResult({
      ...base,
      actions: [
        {
          name: "browser_click",
          input: {},
          output: "",
          metadata: { error: "timed out" },
          timestamp: "2026-08-31T12:00:25.000Z",
          durationMs: 2000,
        },
      ] as never,
      browserLogs: [
        log({
          level: "error",
          message: "the server responded with a status of 500",
          timestamp: "2026-08-31T12:00:26.000Z",
        }),
      ],
    });
    expect(out.signals).toContain("http_5xx");
  });

  it("classifies an agent that produced no actions at all as a provider failure", () => {
    // Structural, not a string match: the provider branches in the runner all
    // end the same way and their wording is not a contract.
    const out = signalsFromTestResult({ ...base, status: "error", actions: [], reason: "" });
    expect(out.signals).toContain("agent_provider_error");
  });

  it("still reads the reason string when there is no browser evidence at all", () => {
    const out = signalsFromTestResult({ ...base, reason: "Failed to create browser context", baseUrl: null });
    expect(out.signals).toContain("runner_setup_failed");
  });
});
