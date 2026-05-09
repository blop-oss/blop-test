import type { BrowserContextOptions } from "playwright";

export type BlopTestStatus = "passed" | "failed" | "error";

export type BlopReporter = "basic" | "json" | "junit" | "all";

export type BlopBrowserName = "chromium" | "firefox" | "webkit";

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
  headed?: boolean;
  browser?: BlopBrowserName;
  viewport?: { width: number; height: number };
  provider?: string;
  model?: string;
  apiKey?: string;
  cwd?: string;
  maxSteps?: number;
  timeoutMs?: number;
  retries?: number;
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
