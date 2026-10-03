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

  // The harness stamps `timestamp` when the call *returns*, alongside
  // durationMs, so a step ran over [timestamp - durationMs, timestamp]. These
  // three tests pin that direction: getting it backwards silently discards the
  // logs a slow failure produced, which are the ones worth reading.
  const slowClick = [
    {
      name: "browser_click",
      input: {},
      output: "",
      metadata: { error: "timed out" },
      // Ended at 12:00:30 after running for 30s, i.e. from 12:00:00.
      timestamp: "2026-08-31T12:00:30.000Z",
      durationMs: 30_000,
    },
  ] as never;

  it("ignores console noise from before the failing step began", () => {
    // A staging environment that always 500s an analytics beacon would
    // otherwise push every failure in that project toward one class -
    // deterministic, and consistently wrong for that project, which is exactly
    // what "the same root cause lands in the same class" forbids.
    const out = signalsFromTestResult({
      ...base,
      finishedAt: "2026-08-31T12:00:31.000Z",
      actions: slowClick,
      browserLogs: [
        log({
          level: "error",
          message: "the server responded with a status of 500",
          // Well before the click started at 12:00:00.
          timestamp: "2026-08-31T11:59:50.000Z",
        }),
      ],
    });
    expect(out.signals).not.toContain("http_5xx");
  });

  it("keeps console noise from inside a long-running failing step", () => {
    const out = signalsFromTestResult({
      ...base,
      finishedAt: "2026-08-31T12:00:31.000Z",
      actions: slowClick,
      browserLogs: [
        log({
          level: "error",
          message: "the server responded with a status of 500",
          // Mid-click. The whole point: a 30s timeout emits its evidence long
          // before the action's own timestamp.
          timestamp: "2026-08-31T12:00:05.000Z",
        }),
      ],
    });
    expect(out.signals).toContain("http_5xx");
  });

  it("keeps a log that landed just after the failing step returned", () => {
    const out = signalsFromTestResult({
      ...base,
      finishedAt: "2026-08-31T12:00:31.000Z",
      actions: slowClick,
      browserLogs: [
        log({ type: "pageerror", message: "boom", timestamp: "2026-08-31T12:00:30.500Z" }),
      ],
    });
    expect(out.signals).toContain("page_error");
  });

  it("classifies an agent that produced no actions at all as a provider failure", () => {
    // Structural, not a string match: the provider branches in the runner all
    // end the same way and their wording is not a contract.
    const out = signalsFromTestResult({ ...base, status: "error", actions: [], reason: "" });
    expect(out.signals).toContain("agent_provider_error");
  });

  it("never lets the agent's own words about the app trip the infrastructure gate", () => {
    // runner.ts sets `reason` to the free-form text the agent passed to
    // finish_test. An agent describing a broken order page must not classify
    // as someone else's outage - that would suppress healing on a genuine
    // regression, the exact inversion #369 exists to prevent.
    const out = signalsFromTestResult({
      ...base,
      reason: "Failed to load the order history: the table stayed empty",
      actions: [
        {
          name: "browser_click",
          input: {},
          output: "ok",
          timestamp: "2026-08-31T12:00:10.000Z",
          durationMs: 10,
        },
      ] as never,
    });
    expect(out.signals).not.toContain("runner_setup_failed");
  });

  it("names the last real action when no tool threw", () => {
    // The common blop failure: every tool succeeded and the agent then called
    // finish_test with a failed verdict. Reporting the first action would name
    // browser_goto and anchor the evidence window at the start of the run.
    const out = signalsFromTestResult({
      ...base,
      actions: [
        { name: "browser_goto", input: {}, output: "ok", timestamp: "2026-08-31T12:00:02.000Z", durationMs: 5 },
        { name: "browser_type", input: {}, output: "ok", timestamp: "2026-08-31T12:00:04.000Z", durationMs: 5 },
        { name: "browser_expect_text", input: {}, output: "ok", timestamp: "2026-08-31T12:00:06.000Z", durationMs: 5 },
      ] as never,
    });
    expect(out.failingTool).toBe("browser_expect_text");
  });

  it("still reads the reason string when there is no browser evidence at all", () => {
    const out = signalsFromTestResult({ ...base, reason: "Failed to create browser context", baseUrl: null });
    expect(out.signals).toContain("runner_setup_failed");
  });
});
