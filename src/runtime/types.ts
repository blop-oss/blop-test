import type { BrowserContextOptions } from "playwright";

export type BlopTestStatus = "passed" | "failed" | "error";

export type BlopReporter = "basic" | "json" | "junit" | "all";

export type BlopBrowserName = "chromium" | "firefox" | "webkit";

export type BlopReasoningEffort = "none" | "low" | "medium" | "high" | "max";

export type BlopAgentStreamEvent = {
  event_type: string;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  workspace_id?: string | null;
  session_id?: string | null;
};

export type BlopAgentStreamRunner = (options: {
  prompt: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  reasoningEffort?: BlopReasoningEffort;
  cwd?: string;
  nativeTools: unknown[];
  signal?: AbortSignal;
}) => AsyncIterable<BlopAgentStreamEvent>;

export type BlopAgentTest = {
  name: string;
  goal: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type BlopAgentStep =
  | { type: "goto"; url: string }
  | { type: "goal"; goal: string };

export type BlopAgent = {
  goto: (url: string) => Promise<void>;
  goal: (goal: string) => Promise<void>;
};

export type BlopAgentTestContext = {
  agent: BlopAgent;
  baseUrl?: string;
};

export type BlopAgentTestHandler = (context: BlopAgentTestContext) => void | Promise<void>;

export type BlopRunOptions = {
  specFile?: string;
  specFiles?: string[];
  baseUrl?: string;
  reportDir?: string;
  /**
   * Append-only NDJSON file the runner writes live progress to (one JSON object
   * per line: test_start, action, test_finish). Lets a host process tail agent
   * activity while the run is still in flight instead of waiting for the final
   * report. Ignored when unset.
   */
  progressFile?: string;
  /** Capture a compact JPEG after each browser action for a visual step trail. */
  captureStepScreenshots?: boolean;
  /**
   * Stream the page live via a CDP screencast (chromium only) instead of taking
   * a blocking screenshot per action. Keeps a fresh "latest view" for the host
   * and serves per-action step screenshots from in-memory frames. When a
   * progressFile is set, the runner also appends throttled `frame` progress
   * lines pointing at the latest live frame on disk. Defaults to on.
   */
  streamFrames?: boolean;
  /** Minimum ms between streamed `frame` progress lines. Defaults to 200ms. */
  frameIntervalMs?: number;
  headed?: boolean;
  browser?: BlopBrowserName;
  containerized?: boolean | { image?: string; containerName?: string };
  viewport?: { width: number; height: number };
  provider?: string;
  model?: string;
  apiKey?: string;
  /** Provider reasoning budget when supported by the OpenAI-compatible API. */
  reasoningEffort?: BlopReasoningEffort;
  cwd?: string;
  /**
   * Optional hard cap on agent tool steps. Unset by default: the agent runs
   * until it calls finish_test, the test times out, or the runner's stall
   * guard detects it looping without progress.
   */
  maxSteps?: number;
  timeoutMs?: number;
  retries?: number;
  /** Number of agent tests to run concurrently. Defaults to 1. */
  workers?: number;
  platformUrl?: string;
  platformApiKey?: string;
  browserContext?: BrowserContextOptions;
  reporter?: BlopReporter;
  agentStream?: BlopAgentStreamRunner;
  verbose?: boolean;
};

export type BlopConfig = Omit<BlopRunOptions, "specFile" | "specFiles" | "agentStream"> & {
  include?: string[];
  exclude?: string[];
};

export type BlopAgentEvent = {
  event_type: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  workspace_id?: string | null;
  session_id?: string | null;
  timestamp: string;
};

export type BlopAction = {
  name: string;
  input: Record<string, unknown>;
  output: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
};

export type BlopScreenshot = {
  path: string;
  name: string;
  checkpoint?: string;
  reason?: string;
  target?: string;
  focused: boolean;
  fullPage: boolean;
  timestamp: string;
};

export type BlopCriticalPoint = {
  id: string;
  description: string;
  status: "pending" | "passed" | "failed";
  evidence?: string;
  screenshot?: string;
  timestamp: string;
};

export type BlopBrowserLog = {
  type: "console" | "pageerror" | "requestfailed";
  level?: string;
  message: string;
  url?: string;
  timestamp: string;
};

export type BlopTestResult = {
  id: string;
  name: string;
  status: BlopTestStatus;
  reason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempts: number;
  baseUrl: string | null;
  provider: string | null;
  model: string | null;
  ci: BlopCiMetadata;
  screenshots: string[];
  screenshotArtifacts: BlopScreenshot[];
  criticalPoints: BlopCriticalPoint[];
  browserLogs: BlopBrowserLog[];
  actions: BlopAction[];
  events: BlopAgentEvent[];
};

export type BlopRunResult = {
  runId: string;
  status: BlopTestStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: BlopTestResult[];
};

export type BlopCiMetadata = {
  provider: string | null;
  runId: string | null;
  jobId: string | null;
  branch: string | null;
  commitSha: string | null;
  pullRequest: string | null;
};
