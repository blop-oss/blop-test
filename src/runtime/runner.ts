import "../node/bun-ws-compat.js";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBrowserAgentStream } from "./agent-loop.js";
import { chromium, firefox, webkit, type Page } from "playwright";
import { createBrowserTools, type FinishState } from "../browser/tools.js";
import { startScreencast, type Screencast } from "../browser/screencast.js";
import { getCiMetadata } from "../node/ci.js";
import { startPlaywrightContainer, type PlaywrightContainerSession } from "../node/playwright-container.js";
import { uploadRunToPlatform } from "../platform/upload.js";
import { writeReports } from "../reporters/index.js";
import { loadAgentTests } from "./spec.js";
import type { BlopAgentEvent, BlopBrowserLog, BlopCriticalPoint, BlopRunOptions, BlopRunResult, BlopScreenshot, BlopTestResult, BlopTestStatus } from "./types.js";

// There is no default step cap: the agent keeps working until it calls
// finish_test, the test times out, or the stall guard below trips. An explicit
// maxSteps still acts as a hard cap for callers that want one.
//
// Stall guard: a window of recent action signatures (tool + input + output).
// When the window is full and the agent is cycling through at most
// STALL_UNIQUE_THRESHOLD distinct signatures, nothing on the page is changing
// and no new evidence is being produced — the run is aborted instead of
// looping forever. Legitimate repetition (e.g. paging with identical clicks)
// stays distinct because each page yields different action output.
const STALL_WINDOW = 12;
const STALL_UNIQUE_THRESHOLD = 2;

// Resume guard: small models sometimes end a turn with planning prose and no
// tool call, which ends the agent session even though the test is mid-flight.
// The browser stays live within the attempt, so the runner re-prompts the
// agent with its progress instead of failing the test — at most this many
// times, after which the run is classified honestly.
const MAX_AGENT_RESUMES = 2;

export async function runBlopTest(options: BlopRunOptions): Promise<BlopRunResult> {
  if (!options.specFile) {
    throw new Error("runBlopTest requires specFile.");
  }

  return runBlopTests({ ...options, specFiles: [options.specFile] });
}

export async function runBlopTests(options: BlopRunOptions): Promise<BlopRunResult> {
  const reportDir = resolve(options.reportDir ?? ".blop");
  const specFiles = (options.specFiles ?? (options.specFile ? [options.specFile] : [])).map((specFile) => resolve(specFile));

  if (specFiles.length === 0) {
    throw new Error("No Blop spec files were provided.");
  }

  const runId = createId("run");
  const startedAt = new Date();
  const results: BlopTestResult[] = [];
  const hasLiveAgent = !options.agentStream;
  let runError: string | null = null;

  // Live progress sink. When a host (e.g. the web app) passes progressFile, we
  // append one NDJSON line per lifecycle event so it can tail agent activity
  // while the run is still in flight instead of waiting for the final report.
  const progressPath = options.progressFile ? resolve(options.progressFile) : null;
  if (progressPath) {
    try {
      writeFileSync(progressPath, "");
    } catch {
      // Non-fatal: progress streaming is best-effort.
    }
  }
  const appendProgress = (entry: Record<string, unknown>) => {
    if (!progressPath) return;
    try {
      appendFileSync(progressPath, `${JSON.stringify(entry)}\n`);
    } catch {
      // Ignore progress write failures; they must never break a run.
    }
  };

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let containerSession: PlaywrightContainerSession | null = null;
  try {
    if (options.containerized) {
      const containerOptions = typeof options.containerized === "object" ? options.containerized : {};
      containerSession = await startPlaywrightContainer(containerOptions);
      browser = containerSession.browser as any;
    } else {
      const browserType = { chromium, firefox, webkit }[options.browser ?? "chromium"];
      browser = await browserType.launch({ headless: !options.headed });
    }

    try {
      for (const specFile of specFiles) {
        let tests;
        try {
          tests = await loadAgentTests(specFile);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({
            id: createId("test"),
            name: `(load error: ${specFile})`,
            status: "error",
            reason: `Failed to load spec file: ${message}`,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 0,
            attempts: 0,
            baseUrl: options.baseUrl ?? null,
            provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER ?? null,
            model: options.model ?? process.env.BLOP_AGENT_MODEL ?? null,
            ci: getCiMetadata(),
            screenshots: [],
            screenshotArtifacts: [],
            criticalPoints: [],
            browserLogs: [],
            actions: [],
            events: [],
          });
          continue;
        }

        for (const test of tests) {
          const testId = createId("test");
          const screenshotsDir = join(reportDir, "screenshots", testId);
          try {
            await mkdir(screenshotsDir, { recursive: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({
              id: testId,
              name: test.name,
              status: "error",
              reason: `Failed to create screenshots directory: ${message}`,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              durationMs: 0,
              attempts: 0,
              baseUrl: test.baseUrl ?? options.baseUrl ?? null,
              provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER ?? null,
              model: options.model ?? process.env.BLOP_AGENT_MODEL ?? null,
              ci: getCiMetadata(),
              screenshots: [],
              screenshotArtifacts: [],
              criticalPoints: [],
              browserLogs: [],
              actions: [],
              events: [],
            });
            continue;
          }

          const actions: BlopTestResult["actions"] = [];
          const screenshots: string[] = [];
          const screenshotArtifacts: BlopScreenshot[] = [];
          const criticalPoints: BlopCriticalPoint[] = [];
          const browserLogs: BlopBrowserLog[] = [];
          const events: BlopAgentEvent[] = [];
          const testStartedAt = new Date();
          let status: BlopTestStatus = "error";
          let reason = "The agent did not finish the test.";
          let attempts = 0;

          appendProgress({
            type: "test_start",
            test: test.name,
            goal: test.goal,
            baseUrl: test.baseUrl ?? options.baseUrl ?? null,
            timestamp: new Date().toISOString(),
          });

          for (let attempt = 1; attempt <= (options.retries ?? 0) + 1; attempt += 1) {
            attempts = attempt;
            let context;
            try {
              context = await browser!.newContext({
                ...options.browserContext,
                viewport: options.viewport ?? options.browserContext?.viewport,
              });
            } catch (error) {
              status = "error";
              reason = `Failed to create browser context: ${error instanceof Error ? error.message : String(error)}`;
              if (attempt > (options.retries ?? 0)) break;
              continue;
            }

            const page = await context.newPage();
            attachBrowserLogListeners(page, browserLogs, attempt);

            // Live page stream: a CDP screencast (chromium only) pushes JPEG
            // frames as the page repaints, so the host always has the latest
            // view and per-action step screenshots come from memory instead of
            // a blocking capture. Best-effort — returns null off chromium.
            let screencast: Screencast | null = null;
            const liveFramePath = join(screenshotsDir, "live.jpg");
            // Only stream when something consumes it: per-action step screenshots
            // or a progress file feeding a host's live view. Pure CI runs pay
            // nothing.
            const wantStream =
              options.streamFrames !== false && (options.captureStepScreenshots || Boolean(progressPath));
            if (wantStream) {
              let lastFrameEmit = 0;
              const frameIntervalMs = options.frameIntervalMs ?? 200;
              const streamViewport = options.viewport ?? options.browserContext?.viewport ?? undefined;
              screencast = await startScreencast({
                page,
                maxWidth: streamViewport?.width,
                maxHeight: streamViewport?.height,
                onFrame: (frame) => {
                  if (!progressPath) return;
                  const now = Date.now();
                  if (now - lastFrameEmit < frameIntervalMs) return;
                  lastFrameEmit = now;
                  // Write atomically (temp + rename) so the host never reads a
                  // half-written frame, then point a progress line at it.
                  const tmp = `${liveFramePath}.${frame.seq}.tmp`;
                  writeFile(tmp, frame.data)
                    .then(() => rename(tmp, liveFramePath))
                    .then(() =>
                      appendProgress({
                        type: "frame",
                        test: test.name,
                        path: liveFramePath,
                        seq: frame.seq,
                        timestamp: new Date(frame.timestamp).toISOString(),
                      }),
                    )
                    .catch(() => {
                      // Frame streaming is best-effort; never break the run.
                    });
                },
              });
            }

            const finishState: FinishState = { status: null, reason: null };
            const controller = new AbortController();
            const timeoutMs = test.timeoutMs ?? options.timeoutMs;
            const timeout = timeoutMs
              ? setTimeout(() => controller.abort(new Error(`Test timed out after ${timeoutMs}ms`)), timeoutMs)
              : null;

            try {
              const recentActionSignatures: string[] = [];
              const nativeTools = await createBrowserTools({
                page,
                testId,
                screenshotDir: screenshotsDir,
                actions,
                screenshots,
                screenshotArtifacts,
                criticalPoints,
                finishState,
                browserLogs,
                baseUrl: test.baseUrl ?? options.baseUrl,
                captureStepScreenshots: options.captureStepScreenshots,
                liveFrame: () => screencast?.latest() ?? null,
                onAction: (action) => {
                  recentActionSignatures.push(
                    `${action.name}|${JSON.stringify(action.input)}|${action.output}`,
                  );
                  if (recentActionSignatures.length > STALL_WINDOW) recentActionSignatures.shift();
                  if (
                    recentActionSignatures.length === STALL_WINDOW &&
                    new Set(recentActionSignatures).size <= STALL_UNIQUE_THRESHOLD
                  ) {
                    controller.abort(
                      new Error(
                        `The agent appears to be stuck: the last ${STALL_WINDOW} browser actions cycled through the same calls with identical results. The run was stopped to avoid an endless loop.`,
                      ),
                    );
                  }
                  appendProgress({
                    type: "action",
                    test: test.name,
                    name: action.name,
                    input: action.input,
                    output: action.output,
                    error:
                      typeof action.metadata?.error === "string" ? action.metadata.error : null,
                    screenshotPath: screenshotPathFor(action),
                    timestamp: action.timestamp,
                  });
                },
              });

              const prompt = buildPrompt({
                name: test.name,
                goal: test.goal,
                baseUrl: test.baseUrl ?? options.baseUrl,
                maxSteps: options.maxSteps,
              });

              let stepCount = 0;
              let lastAgentError: string | null = null;
              const agentStream = options.agentStream ?? runBrowserAgentStream;
              // Small models sometimes end a turn with planning prose and no
              // tool call, which ends the agent session mid-test. The browser
              // is still live, so instead of reporting an unfinished test we
              // resume the agent with its progress so far, a bounded number
              // of times.
              let resumes = 0;
              let sessionPrompt = prompt;
              agentSessions: while (true) {
              for await (const event of agentStream({
                prompt: sessionPrompt,
                provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER,
                model: options.model ?? process.env.BLOP_AGENT_MODEL,
                apiKey: options.apiKey ?? process.env.BLOP_AGENT_API_KEY,
                cwd: options.cwd ?? process.cwd(),
                nativeTools,
                signal: controller.signal,
              })) {
                if (controller.signal.aborted) {
                  // A verdict that already landed beats a late abort (e.g. a
                  // timeout firing between finish_test and stream end).
                  if (finishState.status !== null) break;
                  throw controller.signal.reason instanceof Error
                    ? controller.signal.reason
                    : new Error("Test timed out.");
                }

                const captured = {
                  event_type: String(event.event_type),
                  content: event.content ?? null,
                  metadata: { ...(event.metadata ?? {}), attempt },
                  workspace_id: event.workspace_id ?? null,
                  session_id: event.session_id ?? null,
                  timestamp: new Date().toISOString(),
                } satisfies BlopAgentEvent;
                events.push(captured);

                if (event.event_type === "error" && event.content) {
                  lastAgentError = event.content;
                }

                if (event.event_type === "step_start") {
                  stepCount += 1;
                  if (options.verbose) {
                    const tool = event.metadata && typeof event.metadata === "object" && "tool" in event.metadata ? String(event.metadata.tool) : null;
                    const label = event.content ? `: ${event.content}` : "";
                    console.error(`  [step ${stepCount}] ${tool ?? "agent"}${label}`);
                  }
                }
                if (options.verbose && (event.event_type === "tool_result" || event.event_type === "step_finish")) {
                  const output = event.content ? `    ${event.content.slice(0, 120)}${event.content.length > 120 ? "..." : ""}` : null;
                  if (output) console.error(output);
                }

                // finish_test delivers the verdict; stop consuming and tell
                // the agent to stop. Small models sometimes keep stepping
                // after calling finish, burning steps until a cap or stall
                // guard turns an already-finished test into an error.
                if (finishState.status !== null) {
                  controller.abort(new Error("finish_test was called; stopping the agent."));
                  break;
                }

                if (options.maxSteps && stepCount > options.maxSteps) {
                  const resolvedProvider = options.provider ?? process.env.BLOP_AGENT_PROVIDER;
                  const hasApiKey = !!(options.apiKey ?? process.env.BLOP_AGENT_API_KEY);
                  const hint = !hasApiKey
                    ? `\n\nNo API key is configured. Set one via:\n  BLOP_AGENT_API_KEY=sk-...\n  ${providerEnvHint(resolvedProvider)}\n  --api-key sk-...\n  blop.config.ts: apiKey: 'sk-...'`
                    : "\n\nTry increasing --max-steps, or drop it entirely — without a cap the run only stops on finish_test, timeout, or the no-progress stall guard.";
                  throw new Error(`Agent exceeded max step count of ${options.maxSteps}${hint}`);
                }
              }

              if (
                finishState.status === null &&
                !controller.signal.aborted &&
                !lastAgentError &&
                actions.length > 0 &&
                resumes < MAX_AGENT_RESUMES
              ) {
                resumes += 1;
                if (options.verbose) {
                  console.error(
                    `  [resume ${resumes}/${MAX_AGENT_RESUMES}] agent session ended without finish_test; resuming with progress so far`,
                  );
                }
                sessionPrompt = buildResumePrompt({
                  name: test.name,
                  goal: test.goal,
                  baseUrl: test.baseUrl ?? options.baseUrl,
                  maxSteps: options.maxSteps,
                  criticalPoints,
                  actions,
                });
                continue agentSessions;
              }
              break agentSessions;
              }

              // The stream may end gracefully after an abort (e.g. the stall
              // guard tripped and the agent honoured the signal). Surface the
              // abort reason instead of reporting a silent unfinished test.
              // A finish_test verdict takes precedence: the abort above is
              // just our own stop signal to the agent.
              if (controller.signal.aborted && finishState.status === null) {
                throw controller.signal.reason instanceof Error
                  ? controller.signal.reason
                  : new Error("Test aborted.");
              }

              if (hasLiveAgent && events.length === 0) {
                const resolvedProvider = options.provider ?? process.env.BLOP_AGENT_PROVIDER;
                const hasApiKey = !!(options.apiKey ?? process.env.BLOP_AGENT_API_KEY);
                if (!hasApiKey) {
                  status = "error";
                  reason =
                    "The agent did not produce any output — likely because no API key is configured.\n\n" +
                    "Set your API key via one of:\n" +
                    "  - Environment:       BLOP_AGENT_API_KEY=sk-...\n" +
                    `  - Provider env var:   ${providerEnvHint(resolvedProvider)}\n` +
                    "  - CLI:               --api-key sk-...\n" +
                    "  - blop.config.ts:    apiKey: 'sk-...'\n\n" +
                    `To set the provider and model:\n` +
                    `  - Environment:  BLOP_AGENT_PROVIDER=openai BLOP_AGENT_MODEL=gpt-5\n` +
                    "  - CLI:          --provider openai --model gpt-5\n" +
                    "  - Config file:  provider: 'openai', model: 'gpt-5'";
                  break;
                }
              }

              if (hasLiveAgent && events.length > 0 && actions.length === 0 && finishState.status === null) {
                const resolvedProvider = options.provider ?? process.env.BLOP_AGENT_PROVIDER;
                const resolvedModel = options.model ?? process.env.BLOP_AGENT_MODEL;
                const hasApiKey = !!(options.apiKey ?? process.env.BLOP_AGENT_API_KEY);
                status = "error";
                if (lastAgentError) {
                  reason = `The agent provider failed before making any browser tool calls.\n\nProvider: ${resolvedProvider ?? "default"}\nModel: ${resolvedModel ?? "default"}\nLast agent error: ${lastAgentError}\n\nCheck that the provider supports this model and that the API key is valid.`;
                } else {
                  reason = `The agent produced ${events.length} event(s) but made no tool calls — the agent could not interact with the browser.\n\n`;
                  if (!hasApiKey) {
                    reason += `No API key is configured. Set one via:\n  BLOP_AGENT_API_KEY=sk-...\n  ${providerEnvHint(resolvedProvider)}\n  --api-key sk-...\n  blop.config.ts: apiKey: 'sk-...'\n\n`;
                  }
                  reason += "Check that the provider and model are correctly configured and the API key is valid.";
                }
                break;
              }

              if (finishState.status !== null) {
                status = finishState.status;
                reason = finishState.reason ?? reason;
              } else if (lastAgentError) {
                // The stream died mid-test (e.g. the provider rejected a
                // request and exhausted retries). That is a runtime failure,
                // not a verdict on the app under test — report it as such so
                // hosts don't present "the site failed review" to users.
                status = "error";
                reason = `The agent stopped after ${actions.length} action(s) without calling finish_test.\n\nLast agent error: ${lastAgentError}`;
              } else if (MANGLED_TOOL_CALL_TEXT.test(lastTurnText(events))) {
                // Small models sometimes drift out of the tool-calling format
                // and serialize calls as text (e.g. "<|tool_call>call:..."),
                // which the agent runtime discards; the stream then ends with
                // no real tool call. Like a dead stream, that is a model
                // failure, not a finding about the app under test.
                status = "error";
                reason = `The agent stopped after ${actions.length} action(s) without calling finish_test: its final message wrote tool calls as plain text instead of using the tool-calling interface, so they were never executed. This is a model output-format failure, not a result for the app under test. Retry the run or use a stronger model.`;
              } else {
                status = "failed";
                reason = finishState.reason ?? reason;
              }
              if (status === "passed" || attempt > (options.retries ?? 0)) break;
            } catch (error) {
              if (finishState.status !== null) {
                // The verdict already landed; this exception is fallout from
                // our own stop signal or late cleanup, not a test result.
                status = finishState.status;
                reason = finishState.reason ?? reason;
                if (status === "passed" || attempt > (options.retries ?? 0)) break;
                continue;
              }
              status = "error";
              reason = error instanceof Error ? error.message : String(error);
              if (hasLiveAgent && reason.includes("API key")) {
                reason = `${reason}\n\nHint: Set the BLOP_AGENT_API_KEY environment variable, the --api-key CLI flag, or the apiKey field in blop.config.ts.`;
              }
              if (attempt > (options.retries ?? 0)) break;
            } finally {
              if (timeout) clearTimeout(timeout);
              if (screencast) {
                try {
                  await screencast.stop();
                } catch {
                  // Stream may already be down with the page.
                }
              }
              try {
                await context.close();
              } catch {
                // Context may already be closed or browser crashed.
              }
            }
          }

          const testFinishedAt = new Date();
          appendProgress({
            type: "test_finish",
            test: test.name,
            status,
            reason,
            timestamp: testFinishedAt.toISOString(),
          });
          results.push({
            id: testId,
            name: test.name,
            status,
            reason,
            startedAt: testStartedAt.toISOString(),
            finishedAt: testFinishedAt.toISOString(),
            durationMs: testFinishedAt.getTime() - testStartedAt.getTime(),
            attempts,
            baseUrl: test.baseUrl ?? options.baseUrl ?? null,
            provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER ?? null,
            model: options.model ?? process.env.BLOP_AGENT_MODEL ?? null,
            ci: getCiMetadata(),
            screenshots,
            screenshotArtifacts,
            criticalPoints,
            browserLogs,
            actions,
            events,
          });
        }
      }
    } finally {
      try {
        if (containerSession) {
          await containerSession.stop();
        } else {
          await browser?.close();
        }
      } catch {
        // Browser may already be closed or crashed.
      }
    }
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  }

  if (runError) {
    results.push({
      id: createId("test"),
      name: "(run error)",
      status: "error",
      reason: runError,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      attempts: 0,
      baseUrl: options.baseUrl ?? null,
      provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER ?? null,
      model: options.model ?? process.env.BLOP_AGENT_MODEL ?? null,
      ci: getCiMetadata(),
      screenshots: [],
      screenshotArtifacts: [],
      criticalPoints: [],
      browserLogs: [],
      actions: [],
      events: [],
    });
  }

  const finishedAt = new Date();
  const status = summarizeStatus(results);
  const result: BlopRunResult = {
    runId,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    results,
  };

  try {
    await writeReports(reportDir, result, options.reporter ?? "all");
  } catch (error) {
    console.error(`Failed to write reports: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await uploadRunToPlatform({
      platformUrl: options.platformUrl ?? process.env.BLOP_PLATFORM_URL,
      apiKey: options.platformApiKey ?? process.env.BLOP_API_KEY,
      result,
    });
  } catch (error) {
    console.error(`Failed to upload results to platform: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/** Resolve the screenshot file an action produced, if any, for progress streaming. */
function screenshotPathFor(action: { name: string; metadata?: Record<string, unknown> }): string | null {
  const stepShot = action.metadata?.stepScreenshotPath;
  if (typeof stepShot === "string") return stepShot;
  // Explicit browser_screenshot calls record their file under metadata.path.
  if (action.name === "browser_screenshot" && typeof action.metadata?.path === "string") {
    return action.metadata.path;
  }
  return null;
}

function attachBrowserLogListeners(page: Page, browserLogs: BlopBrowserLog[], attempt: number) {
  page.on("console", (message) => {
    browserLogs.push({
      type: "console",
      level: message.type(),
      message: message.text(),
      timestamp: new Date().toISOString(),
      url: page.url(),
    });
  });
  page.on("pageerror", (error) => {
    browserLogs.push({
      type: "pageerror",
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
      url: page.url(),
      level: `attempt:${attempt}`,
    });
  });
  page.on("requestfailed", (request) => {
    browserLogs.push({
      type: "requestfailed",
      message: request.failure()?.errorText ?? "Request failed",
      timestamp: new Date().toISOString(),
      url: request.url(),
      level: `attempt:${attempt}`,
    });
  });
}

function providerEnvHint(provider: string | undefined): string {
  const envVar = provider
    ? ({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", groq: "GROQ_API_KEY", xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY", cerebras: "CEREBRAS_API_KEY", nvidia: "NVIDIA_API_KEY" } as Record<string, string>)[provider]
    : null;
  return envVar ? `${envVar}=sk-...` : "OPENAI_API_KEY=sk-... or ANTHROPIC_API_KEY=sk-ant-...";
}

// Tool calls serialized into the text channel by models that drift out of the
// tool-calling format, e.g. "<|tool_call>call:finish_test{status:<|"|>passed".
const MANGLED_TOOL_CALL_TEXT = /<\|?\/?tool_call\b|\bcall:[a-z_]+\s*\{/i;

/** Text of the agent's last LLM turn, reassembled from streamed deltas. */
function lastTurnText(events: BlopAgentEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.event_type === "llm_call_start") text = "";
    else if (event.event_type === "text_delta" && event.content) text += event.content;
  }
  return text;
}

function promptBody(input: { baseUrl?: string; maxSteps?: number }) {
  const startInstruction = input.baseUrl
    ? `The app base URL is ${input.baseUrl}. Resolve relative URLs in the goal against this base URL.`
    : "If the goal requires a URL, use browser_goto with the URL supplied by the test.";
  const budgetInstruction = input.maxSteps
    ? `Stay within ${input.maxSteps} tool steps.`
    : "Take as many tool steps as the goal genuinely needs — but never repeat an action that already returned the same result. If you are blocked, gather evidence of the blocker and finish with a failed status instead of retrying in a loop.";

  return `How to act (critical):\n- Act only by calling the provided browser tools through the tool-calling interface, one or more calls per turn.\n- Never write a tool call as message text. No pseudo-XML tags, no token markers, no JSON arguments in prose: text like that is discarded and no action happens.\n- The test ends only when you call finish_test with status and reason. A plain-text reply without a tool call aborts the run as unfinished, and any findings in it are lost.\n- When the goal is complete or blocked, your next tool call is finish_test. Put your summary or feedback in its reason field, not in a text message.\n\nRules:\n- ${startInstruction}\n- Start by decomposing the goal into critical points: every explicit page, action, assertion, filter, sort, selection, value, or final datum that must be proven.\n- Use browser_snapshot before important actions; it includes visible text plus ARIA roles/labels. Prefer role, label, placeholder, test id, or text targets over brittle CSS.\n- Use record_critical_point for each requirement. Mark a point passed only when a deterministic assertion, URL, visible text, screenshot, or action output proves it.\n- Prefer deterministic assertions such as browser_expect_text, browser_expect_url, browser_expect_value, browser_expect_checked, browser_expect_visible, browser_expect_count, and browser_expect_attribute before passing. They auto-retry until timeoutMs (default 5000ms), so do not pad them with manual waits; raise timeoutMs for slow UIs instead.\n- For lists, tables, rankings, sorts, and counts, use browser_extract to read the visible data of ALL matching elements in one call, then compare. Never read rows one by one or eyeball order from a screenshot.\n- When you can already predict a deterministic sequence (fill, click, assert), batch it with browser_run_steps in one call instead of one call per action. Explore with browser_snapshot first; never batch steps you are unsure about.\n- When submitting a form (sign in, create account, checkout), first fill EVERY required field the form shows — snapshot the form and do not assume it is just email + password; account/signup forms often also require a name, username, password confirmation, or a terms checkbox. If a submit click or Enter reports that the form did not submit because fields are invalid, fill the named fields and submit again rather than re-clicking or treating the button as dead.\n- If the app looks broken (blank page, dead button, missing data), check browser_console_logs for uncaught errors and failed requests, and cite the log line as evidence before failing the test as an app bug.\n- Capture screenshots only when they add useful evidence. When one element or region proves the point, pass target to browser_screenshot so the screenshot captures the smallest relevant area; avoid fullPage unless the whole layout is the evidence.\n- Do not guess UI state. If selected state is hidden after a drawer, accordion, modal, or dropdown closes, reopen it or capture a visible chip/summary before treating it as verified.\n- If a site exposes a dedicated control for a requirement, use that control. A broad search query does not satisfy explicit filters, sorts, styles, attributes, or rankings.\n- Ranking words such as cheapest, latest, highest-rated, best-selling, or most reviewed must be grounded in the app's actual sort/filter or visible metric.\n- Numeric, date, quantity, and unit constraints must be exact. Wider buckets or broadened defaults are failures unless no exact control exists.\n- Empty results are acceptable only after the correct filters/actions were applied and evidenced.\n- For blocker claims, capture current evidence and only fail after repeated evidence from the actual UI.\n- Only use the provided browser tools; do not change files or invoke external processes.\n- ${budgetInstruction}\n- You must finish by calling finish_test with status and reason. Use passed only after all critical points are passed or otherwise proven by deterministic assertions.\n`;
}

function buildPrompt(input: { name: string; goal: string; baseUrl?: string; maxSteps?: number }) {
  return `You are running an agentic browser E2E test.\n\nTest name: ${input.name}\n\nGoal:\n${input.goal}\n\n${promptBody(input)}`;
}

function buildResumePrompt(input: {
  name: string;
  goal: string;
  baseUrl?: string;
  maxSteps?: number;
  criticalPoints: BlopCriticalPoint[];
  actions: BlopTestResult["actions"];
}) {
  const points =
    input.criticalPoints.length > 0
      ? input.criticalPoints
          .map((point) => `- [${point.status}] ${point.id}: ${point.description}`)
          .join("\n")
      : "- none recorded yet";
  const recentActions = input.actions
    .slice(-6)
    .map(
      (action) =>
        `- ${action.name} ${JSON.stringify(action.input ?? {}).slice(0, 120)} -> ${(action.output ?? "").slice(0, 120)}`,
    )
    .join("\n");
  return `You are resuming an agentic browser E2E test that is already in progress. The previous agent session stopped without calling finish_test, so the test is NOT over. The browser is still open on the page the previous session left it on.\n\nTest name: ${input.name}\n\nGoal:\n${input.goal}\n\nProgress so far (do not redo work that is already verified):\nCritical points:\n${points}\nMost recent actions:\n${recentActions}\n\nContinue from the current browser state, complete the remaining critical points, and end by calling finish_test.\n\n${promptBody(input)}`;
}

function summarizeStatus(results: BlopTestResult[]): BlopTestStatus {
  if (results.some((result) => result.status === "error")) return "error";
  if (results.some((result) => result.status === "failed")) return "failed";
  return "passed";
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
