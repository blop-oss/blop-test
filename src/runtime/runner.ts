import {
  createBrowserTools,
  startCamoufoxContainer,
  startPlaywrightContainer,
  startScreencast,
  type CamoufoxContainerSession,
  type FinishState,
  type PlaywrightContainerSession,
  type Screencast,
} from "@blopai/browser-harness";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { getCiMetadata } from "../node/ci.js";
import { resolveOtelConfig } from "../node/otel-config.js";
import { launchLocalBrowser } from "../node/browser-launcher.js";
import { uploadRunToPlatform } from "../platform/upload.js";
import { writeReports } from "../reporters/index.js";
import type { BlopOtelRunSpan, BlopOtelScenarioSpan } from "../reporters/otel.js";
import { runBrowserAgentStream } from "./agent-loop.js";
import { createStepFramePublisher } from "./live-frame-fallback.js";
import { loadAgentTests } from "./spec.js";
import type { BlopAction, BlopAgentEvent, BlopAgentTest, BlopBrowserLog, BlopCriticalPoint, BlopRunOptions, BlopRunResult, BlopScreenshot, BlopTestResult, BlopTestStatus } from "./types.js";

// There is no default step cap: the agent keeps working until it calls
// finish_test, the test times out, or the stall guard below trips. An explicit
// maxSteps still acts as a hard cap for callers that want one.
//
// Stall guard: detect a short action cycle repeated six times. Snapshot output
// contributes a coarse page-state fingerprint with volatile numbers removed,
// so clocks/temperatures cannot disguise a loop while genuinely different page
// content (for example pagination) remains distinct.
const STALL_MAX_CYCLE_LENGTH = 4;
const STALL_CYCLE_REPEATS = 6;

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

  // Telemetry is opt-in and must never be able to fail a run: with no
  // collector configured the OTel SDK is never constructed, and any error
  // setting it up is reported and swallowed.
  let otelRun: BlopOtelRunSpan | null = null;
  let otelConfig: ReturnType<typeof resolveOtelConfig> = null;
  try {
    otelConfig = resolveOtelConfig(options);
    if (otelConfig) {
      // Loaded here, not at module scope: with no collector configured the
      // OpenTelemetry SDK is never even parsed, which is what the docs promise
      // and what keeps it out of every other consumer of this package.
      const { startOtelRun } = await import("../reporters/otel.js");
      otelRun = startOtelRun(otelConfig, {
        runId,
        suiteName: suiteNameFor(specFiles),
        startedAt,
        ci: getCiMetadata(),
        provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER ?? null,
        model: options.model ?? process.env.BLOP_AGENT_MODEL ?? null,
        team: process.env.BLOP_OTEL_TEAM ?? null,
        projectId: process.env.BLOP_PROJECT_ID ?? null,
      });

      // Camoufox exists to be fingerprint-faithful, and a non-standard header
      // on every request is a tell. Honour the explicit opt-in, but say so.
      if (otelConfig.propagateToApp && (options.browser ?? "chromium") === "camoufox") {
        console.error(
          "[blop:otel] Trace propagation is on with the Camoufox browser: the traceparent header is a fingerprinting signal.",
        );
      }
    }
  } catch (error) {
    console.error(
      `Failed to start OpenTelemetry export: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

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

  let browser: Browser | null = null;
  let containerSession: PlaywrightContainerSession | CamoufoxContainerSession | null = null;
  // Resolved after the browser/container is up. When false, third-party
  // request failures during the run are environment limits (no internet
  // egress from the sandbox), not app bugs — the agent prompt is told so.
  let hasInternetEgress = true;
  // True when the browser was launched with web-security disabled (always
  // for the containerized runner). Surfaced to the agent prompt so it treats
  // genuine cross-origin requests as exercisable rather than environment
  // limits.
  let corsBypassed = false;
  const runOneTest = async (test: BlopAgentTest): Promise<BlopTestResult> => {
    const testId = createId("test");
    const screenshotsDir = join(reportDir, "screenshots", testId);
    const otelScenario: BlopOtelScenarioSpan | null =
      otelRun?.startScenario({
        name: test.name,
        specFile: scenarioPathFor(test.specFile, options.cwd),
        baseUrl: test.baseUrl ?? options.baseUrl ?? null,
      }) ?? null;
    try {
      await mkdir(screenshotsDir, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = `Failed to create screenshots directory: ${message}`;
      otelScenario?.end({ status: "error", reason, attempts: 0, durationMs: 0 });
      return {
        id: testId,
        name: test.name,
        status: "error",
        reason,
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
      };
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
    const liveFramePath = join(screenshotsDir, "live.jpg");
    const stepFramePublisher = progressPath
      ? createStepFramePublisher({
          liveFramePath,
          testName: test.name,
          onFrame: appendProgress,
        })
      : null;

    appendProgress({
      type: "test_start",
      test: test.name,
      goal: test.goal,
      baseUrl: test.baseUrl ?? options.baseUrl ?? null,
      timestamp: new Date().toISOString(),
    });

    for (let attempt = 1; attempt <= (options.retries ?? 0) + 1; attempt += 1) {
      attempts = attempt;
      otelScenario?.beginAttempt(attempt);
      let context;
      try {
        context = await browser!.newContext(resolveBrowserContextOptions(options));
      } catch (error) {
        status = "error";
        reason = `Failed to create browser context: ${error instanceof Error ? error.message : String(error)}`;
        if (attempt > (options.retries ?? 0)) break;
        continue;
      }

      // Registering on the context (before any page exists) covers popups too.
      if (otelScenario && otelConfig?.propagateToApp) {
        try {
          const { installTraceparentPropagation } = await import("./otel-propagation.js");
          await installTraceparentPropagation(context, {
            getContext: () => otelScenario.activeContext(),
            allowlist: otelConfig.propagateAllowlist,
          });
        } catch (error) {
          console.error(
            `Failed to install trace propagation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const page = await context.newPage();
      // Registry of every page/tab in this context. The main page is index 0;
      // popups opened by the app via window.open / target=_blank are appended
      // in open order. The tab tools (browser_list_pages /
      // browser_select_page) read this list, and setActivePage swaps the page
      // every other tool operates on so the agent can interact with a popup
      // transparently.
      const pages: Page[] = [page];
      const attachPageListeners = (popup: Page) => {
        pages.push(popup);
        attachBrowserLogListeners(popup, browserLogs, attempt);
        popup.on("close", () => {
          const index = pages.indexOf(popup);
          if (index >= 0) pages.splice(index, 1);
          // If the agent was on the popup that just closed, fall back to the
          // main page so the next tool call doesn't target a dead page.
          if (activePageRef.page === popup) {
            const main = pages[0];
            if (main && !main.isClosed()) {
              activePageRef.page = main;
              void restartScreencast(main).catch(() => {});
            }
          }
        });
      };
      context.on("page", attachPageListeners);

      // The mutable "current page" the tools operate on. Held in a ref object
      // so the tools' closure sees the latest page after a browser_select_page
      // call without re-creating the tools.
      const activePageRef: { page: Page } = { page };
      const setActivePage = (next: Page) => {
        activePageRef.page = next;
        void restartScreencast(next).catch(() => {});
      };

      // Screencast is chromium-only and bound to one page at a time. When the
      // active page changes (popup switch), stop the old stream and start a
      // new one so live frames always reflect what the agent is acting on.
      let screencast: Screencast | null = null;
      const supportsCdpScreencast = browserSupportsCdpScreencast(options);
      const wantStream = supportsCdpScreencast
        && options.streamFrames !== false
        && (options.captureStepScreenshots || Boolean(progressPath));
      const streamViewport = options.viewport ?? options.browserContext?.viewport ?? undefined;
      const startScreencastFor = async (target: Page) => {
        if (!wantStream) return null;
        let lastFrameEmit = 0;
        const frameIntervalMs = options.frameIntervalMs ?? 200;
        return startScreencast({
          page: target,
          maxWidth: streamViewport?.width,
          maxHeight: streamViewport?.height,
          onFrame: (frame) => {
            if (!progressPath) return;
            const now = Date.now();
            if (now - lastFrameEmit < frameIntervalMs) return;
            lastFrameEmit = now;
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
      };
      const restartScreencast = async (target: Page) => {
        if (screencast) {
          try { await screencast.stop(); } catch {}
          screencast = null;
        }
        screencast = await startScreencastFor(target);
      };
      if (wantStream) screencast = await startScreencastFor(page);

      const finishState: FinishState = { status: null, reason: null };
      const controller = new AbortController();
      const timeoutMs = test.timeoutMs ?? options.timeoutMs;
      const timeout = timeoutMs
        ? setTimeout(() => controller.abort(new Error(`Test timed out after ${timeoutMs}ms`)), timeoutMs)
        : null;

      try {
        const recentActionSignatures: string[] = [];
        const nativeTools = await createBrowserTools({
          page: activePageRef.page,
          pages,
          setActivePage,
          getActivePage: () => activePageRef.page,
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
            otelScenario?.recordStep(action);
            const screenshotPath = screenshotPathFor(action);
            recentActionSignatures.push(actionCycleSignature(action));
            const maxHistory = STALL_MAX_CYCLE_LENGTH * STALL_CYCLE_REPEATS;
            if (recentActionSignatures.length > maxHistory) recentActionSignatures.shift();
            if (hasRepeatedActionCycle(recentActionSignatures)) {
              controller.abort(
                new Error(
                  `The agent appears to be stuck: a short browser-action cycle repeated ${STALL_CYCLE_REPEATS} times without meaningful page-state progress. The run was stopped to avoid an endless loop.`,
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
              screenshotPath,
              timestamp: action.timestamp,
            });
            if (!wantStream && screenshotPath) {
              stepFramePublisher?.publish(screenshotPath, action.timestamp);
            }
          },
        });

        // A live span per tool call is what trace propagation injects, and it
        // is what the inner steps of a batching tool nest under.
        const tools = otelScenario ? instrumentTools(nativeTools, otelScenario) : nativeTools;

        const prompt = buildPrompt({
          name: test.name,
          goal: test.goal,
          baseUrl: test.baseUrl ?? options.baseUrl,
          maxSteps: options.maxSteps,
          hasInternetEgress,
          corsBypassed,
        });

        let stepCount = 0;
        let lastAgentError: string | null = null;
        const agentStream = options.agentStream ?? runBrowserAgentStream;
        let resumes = 0;
        let sessionPrompt = prompt;
        agentSessions: while (true) {
          for await (const event of agentStream({
            prompt: sessionPrompt,
            provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER,
            model: options.model ?? process.env.BLOP_AGENT_MODEL,
            apiKey: options.apiKey ?? process.env.BLOP_AGENT_API_KEY,
            reasoningEffort: options.reasoningEffort,
            cwd: options.cwd ?? process.cwd(),
            nativeTools: tools,
            signal: controller.signal,
          })) {
            if (controller.signal.aborted) {
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

            // Usage totals are cumulative per LLM call, so accounting resets
            // when a new call starts.
            if (event.event_type === "llm_call_start") {
              otelScenario?.beginLlmCall();
            }

            if (event.event_type === "usage" && event.metadata) {
              otelScenario?.recordTokens(event.metadata);
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
            otelScenario?.recordResume(resumes, MAX_AGENT_RESUMES);
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
              hasInternetEgress,
              corsBypassed,
              criticalPoints,
              actions,
            });
            continue agentSessions;
          }
          break agentSessions;
        }

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
          status = "error";
          reason = `The agent stopped after ${actions.length} action(s) without calling finish_test.\n\nLast agent error: ${lastAgentError}`;
        } else if (MANGLED_TOOL_CALL_TEXT.test(lastTurnText(events))) {
          status = "error";
          reason = `The agent stopped after ${actions.length} action(s) without calling finish_test: its final message wrote tool calls as plain text instead of using the tool-calling interface, so they were never executed. This is a model output-format failure, not a result for the app under test. Retry the run or use a stronger model.`;
        } else {
          status = "failed";
          reason = finishState.reason ?? reason;
        }
        if (status === "passed" || attempt > (options.retries ?? 0)) break;
      } catch (error) {
        if (finishState.status !== null) {
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
        await stepFramePublisher?.flush();
        try {
          context.off("page", attachPageListeners);
        } catch {
          // Context may already be closed.
        }
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
    const testDurationMs = testFinishedAt.getTime() - testStartedAt.getTime();
    otelScenario?.end({ status, reason, attempts, durationMs: testDurationMs });
    appendProgress({
      type: "test_finish",
      test: test.name,
      status,
      reason,
      timestamp: testFinishedAt.toISOString(),
    });
    return {
      id: testId,
      name: test.name,
      status,
      reason,
      startedAt: testStartedAt.toISOString(),
      finishedAt: testFinishedAt.toISOString(),
      durationMs: testDurationMs,
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
    };
  };

  try {
    if (options.containerized) {
      const containerOptions = typeof options.containerized === "object" ? options.containerized : {};
      containerSession = options.browser === "camoufox"
        ? await startCamoufoxContainer(containerOptions)
        : await startPlaywrightContainer(containerOptions);
      browser = containerSession.browser as any;
      hasInternetEgress = containerSession.hasInternetEgress;
      corsBypassed = containerSession.corsBypassed;
    } else {
      browser = await launchLocalBrowser(options);
      // Non-containerized launches run on the host; assume host egress is
      // whatever the host has. We don't probe here to keep startup fast and
      // because a host browser hitting api.web3forms.com failing is a real
      // network/CORS issue the agent should report as such.
    }

    try {
      for (const specFile of specFiles) {
        let tests;
        try {
          // Stamp the source file onto each test so scenario spans can carry
          // blop.scenario.path; the spec schema strips unknown keys, so this
          // has to happen after loading.
          tests = (await loadAgentTests(specFile)).map((test) => ({ ...test, specFile }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reason = `Failed to load spec file: ${message}`;
          otelRun
            ?.startScenario({
              name: `(load error: ${specFile})`,
              specFile: scenarioPathFor(specFile, options.cwd),
            })
            .end({ status: "error", reason, attempts: 0, durationMs: 0 });
          results.push({
            id: createId("test"),
            name: `(load error: ${specFile})`,
            status: "error",
            reason,
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

        const workerCount = Math.max(1, Math.min(options.workers ?? 1, tests.length));
        const ordered = await runWithWorkers(tests, workerCount, runOneTest);
        results.push(...ordered);
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
      ingestUrl: options.platformUrl ?? process.env.BLOP_INGEST_URL,
      ingestSecret: options.platformApiKey ?? process.env.BLOP_INGEST_SECRET,
      projectId: process.env.BLOP_PROJECT_ID,
      trigger: process.env.BLOP_TRIGGER,
      reportDir,
      result,
    });
  } catch (error) {
    console.error(`Failed to upload results to platform: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Must complete here: the CLI calls process.exit immediately after printing
  // its summary, which would drop anything still buffered.
  try {
    await otelRun?.end({ status, finishedAt, durationMs: result.durationMs });
  } catch (error) {
    console.error(
      `Failed to finish OpenTelemetry export: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}

/**
 * Wrap each tool so the runner sees the boundary *before* execution. The
 * harness only reports an action once it has finished, which is too late to
 * hand a live span's trace context to the app under test.
 */
function instrumentTools<T extends { name: string; execute: (input: Record<string, unknown>) => unknown }>(
  tools: T[],
  scenario: BlopOtelScenarioSpan,
): T[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: Record<string, unknown>) => {
      const step = scenario.beginStep(tool.name, input);
      try {
        const result = await tool.execute(input);
        step.end();
        return result;
      } catch (error) {
        step.end(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  }));
}

/**
 * Report the spec path relative to the working directory. Absolute paths leak
 * the runner's home directory to the collector and are useless for grouping,
 * since they differ between a laptop and a CI worker.
 */
export function scenarioPathFor(specFile: string | undefined, cwd?: string): string | undefined {
  if (!specFile) return undefined;

  const relativePath = relative(cwd ?? process.cwd(), specFile);
  return relativePath && !relativePath.startsWith("..") ? relativePath : specFile;
}

/** Human label for the run span: one spec file reads better than a count. */
export function suiteNameFor(specFiles: string[]): string {
  if (specFiles.length === 1) {
    const file = specFiles[0]!.split(/[\\/]/).pop() ?? specFiles[0]!;
    // Mirrors the spec-file detection pattern: .blop.{ts,tsx,mts,cts,js,...}
    return file.replace(/\.blop\.[cm]?[tj]sx?$/, "");
  }

  return `${specFiles.length} spec files`;
}

/**
 * Build context options for the selected browser backend.
 *
 * Camoufox owns its window size through fingerprint generation. Playwright's
 * viewport emulation sends Chromium-only fields such as `isMobile`, which the
 * Camoufox Firefox protocol rejects. Keep this aligned with browser-harness's
 * Camoufox CLI runtime by disabling viewport emulation entirely.
 */
export function resolveBrowserContextOptions(
  options: Pick<BlopRunOptions, "browser" | "browserContext" | "viewport">,
): BrowserContextOptions {
  return {
    ...options.browserContext,
    viewport: options.browser === "camoufox"
      ? null
      : options.viewport ?? options.browserContext?.viewport,
    // Bypass Content-Security-Policy so the agent can drive flows the app's
    // own CSP would otherwise block in the sandbox (inline event handlers,
    // eval-based vendor SDKs, etc.). CSP is a delivery-time defense, not a
    // behavior the agent is testing for.
    bypassCSP: true,
  };
}

/** Camoufox remains Firefox-based even when reached through a container. */
export function browserSupportsCdpScreencast(
  options: Pick<BlopRunOptions, "browser" | "containerized">,
): boolean {
  return (options.browser ?? "chromium") === "chromium";
}

function actionCycleSignature(action: BlopAction): string {
  const normalizedInput = JSON.stringify(action.input, (key, value: unknown) => {
    if (key !== "ref" || typeof value !== "string") return value;
    if (/^s\d+:e\d+$/.test(value)) return value.replace(/^s\d+:/, "s#:");
    if (/^x\d+$/.test(value)) return "x#";
    return value;
  });
  const base = `${action.name}|${normalizedInput}`;
  if (action.name !== "browser_snapshot") return base;
  try {
    const snapshot = JSON.parse(action.output) as {
      url?: unknown;
      title?: unknown;
      text?: unknown;
      ariaSnapshot?: unknown;
    };
    const state = [snapshot.url, snapshot.title, snapshot.text, snapshot.ariaSnapshot]
      .map((value) => String(value ?? ""))
      .join("|")
      .toLowerCase()
      .replace(/\d+(?:[.:/-]\d+)*/g, "#")
      .replace(/\s+/g, " ")
      .slice(0, 4_000);
    return `${base}|${state}`;
  } catch {
    return `${base}|${action.output.slice(0, 4_000)}`;
  }
}

function hasRepeatedActionCycle(signatures: string[]): boolean {
  for (let cycleLength = 1; cycleLength <= STALL_MAX_CYCLE_LENGTH; cycleLength += 1) {
    const required = cycleLength * STALL_CYCLE_REPEATS;
    if (signatures.length < required) continue;
    const start = signatures.length - required;
    let repeated = true;
    for (let index = start + cycleLength; index < signatures.length; index += 1) {
      if (signatures[index] !== signatures[start + ((index - start) % cycleLength)]) {
        repeated = false;
        break;
      }
    }
    if (repeated) return true;
  }
  return false;
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

function promptBody(input: { baseUrl?: string; maxSteps?: number; hasInternetEgress?: boolean; corsBypassed?: boolean }) {
  const startInstruction = input.baseUrl
    ? `The app base URL is ${input.baseUrl}. Resolve relative URLs in the goal against this base URL.`
    : "If the goal requires a URL, use browser_goto with the URL supplied by the test.";
  const budgetInstruction = input.maxSteps
    ? `Stay within ${input.maxSteps} tool steps.`
    : "Take as many tool steps as the goal genuinely needs — but never repeat an action that already returned the same result. If you are blocked, gather evidence of the blocker and finish with a failed status instead of retrying in a loop.";

  const hasInternetEgress = input.hasInternetEgress !== false;
  const corsBypassed = input.corsBypassed !== false;
  const corsRule = corsBypassed
    ? "- The sandbox browser has web-security disabled and CSP bypassed, so cross-origin requests (OAuth redirects, third-party iframes, cross-origin fetch/XHR) are not blocked by the sandbox itself the way they would be in a vanilla browser. Treat a cross-origin request failure as a real app/provider configuration issue, not a sandbox CORS limitation."
    : "";
  const thirdPartyRules = hasInternetEgress
    ? "- Distinguish first-party failures from third-party failures. browser_console_logs tags each failed request as [first-party] (same origin as the page) or [third-party] (external service). A [first-party] failure or an uncaught JS error from the site's own bundle is a genuine app bug — cite it as evidence. A [third-party] failure (form providers like web3forms.com, payment/checkout providers like stripe.com/paypal.com/razorpay.com, captcha, analytics) is usually a CORS or provider-side rejection: the site's request did reach the internet, but the provider refused it. Report a [third-party] failure as a real issue the site owner should investigate (wrong API key, missing CORS allowlist, misconfigured endpoint), not as a test-environment limitation — the sandbox has confirmed internet egress.\n- When a form submits to a third-party endpoint (e.g. web3forms.com, Formspree) or a checkout redirects to/handshakes with a third-party payment provider (e.g. Stripe, PayPal), exercise the real flow end-to-end and verify the site's success and failure handling. For payment providers that use test mode, use the provider's documented test cards (e.g. Stripe test card 4242 4242 4242 4242, expiry any future date, any CVC) and test keys — never real card numbers. If the provider rejects the request with a CORS or auth error, report it as a real configuration issue the site owner must fix, and flag the specific error from browser_console_logs."
    : "- Distinguish first-party failures from third-party/environment failures. This test sandbox has NO confirmed internet egress, so requests to external services cannot succeed regardless of how the site is configured. browser_console_logs tags each failed request as [first-party] (same origin as the page) or [third-party] (external service). A [first-party] failure or an uncaught JS error from the site's own bundle is a genuine app bug — cite it as evidence. A [third-party] failure (form providers like web3forms.com, payment/checkout providers like stripe.com/paypal.com/razorpay.com, captcha, analytics) is a test-environment limitation here, NOT an app bug: the sandbox cannot reach the internet, so the failure does not reflect the site's wiring. Do not fail the site solely because a [third-party] endpoint is unreachable; note it as a test-environment caveat in your reason and keep evaluating the rest of the flow.\n- When a form submits to a third-party endpoint (e.g. web3forms.com, Formspree) or a checkout redirects to/handshakes with a third-party payment provider (e.g. Stripe, PayPal), verify the client-side submission behavior instead of requiring the external round-trip to succeed: the form fields are present and required validation fires before submit, the submit action triggers the outbound request, and the site handles a failed response gracefully (error UI, not a silent hang). Treat the conversion path as working if the site wired it up correctly, and flag only the unreachable third-party as a test-environment caveat in your reason. For payment providers, note that the site owner should test with the provider's documented test cards (e.g. Stripe test card 4242 4242 4242 4242) and test keys once egress is available.";

  const popupRules = "- When a click opens a new tab or popup (window.open, target=_blank, OAuth/login popup), call browser_list_pages to discover it, then browser_select_page with its index to switch the active page to it before interacting with its contents. Use browser_snapshot after switching to read the popup. Use browser_close_page to dismiss popups you no longer need. The main page is always index 0.";

  return [
    "How to act (critical):",
    "- Act only by calling the provided browser tools through the tool-calling interface, one or more calls per turn.",
    "- Never write a tool call as message text. No pseudo-XML tags, no token markers, no JSON arguments in prose: text like that is discarded and no action happens.",
    "- The test ends only when you call finish_test with status and reason. A plain-text reply without a tool call aborts the run as unfinished, and any findings in it are lost.",
    "- When the goal is complete or blocked, your next tool call is finish_test. Put your summary or feedback in its reason field, not in a text message.",
    "",
    "Rules:",
    `- ${startInstruction}`,
    "- Start by decomposing the goal into critical points: every explicit page, action, assertion, filter, sort, selection, value, or final datum that must be proven.",
    "- Use browser_snapshot before important actions. Prefer a current opaque { ref: \"e1\" } or { ref: \"x1\" } from semanticSnapshot/actionTargets, copy it verbatim, and take a fresh snapshot after navigation. Use role, label, placeholder, test id, or text only when no current ref is available.",
    "- Snapshot lines describe elements; they are not selector strings. When a ref is unavailable, copy the exact observed role/name into a structured target such as { role: \"button\", name: \"Save\" }. Never invent a role/name, paste the whole snapshot line into a string, or reuse a pre-navigation ref.",
    "- Use record_critical_point for each requirement and always include its required id, description, and status fields. Mark a point passed only when a deterministic assertion, URL, visible text, screenshot, or action output proves it.",
    "- Prefer deterministic assertions such as browser_expect_text, browser_expect_url, browser_expect_value, browser_expect_checked, browser_expect_visible, browser_expect_count, and browser_expect_attribute before passing. They auto-retry until timeoutMs (default 5000ms), so do not pad them with manual waits; raise timeoutMs for slow UIs instead.",
    "- For lists, tables, rankings, sorts, and counts, use browser_extract to read the visible data of ALL matching elements in one call, then compare. Never read rows one by one or eyeball order from a screenshot.",
    "- When you can already predict a deterministic sequence (fill, click, assert), batch it with browser_run_steps in one call instead of one call per action. Explore with browser_snapshot first; never batch steps you are unsure about.",
    "- When submitting a form (sign in, create account, checkout), first fill EVERY required field the form shows — snapshot the form and do not assume it is just email + password; account/signup forms often also require a name, username, password confirmation, or a terms checkbox. If a submit click or Enter reports that the form did not submit because fields are invalid, fill the named fields and submit again rather than re-clicking or treating the button as dead.",
    "- If the app looks broken (blank page, dead button, missing data), check browser_console_logs for uncaught errors and failed requests, and cite the log line as evidence before failing the test as an app bug.",
    `- ${popupRules}`,
    ...(corsBypassed ? [corsRule] : []),
    thirdPartyRules,
    "- Capture screenshots only when they add useful evidence. After navigation, omit target for page-level evidence unless a fresh snapshot exposed a new current-page ref. Never reuse the element ref that initiated navigation; avoid fullPage unless the whole layout is the evidence.",
    "- Do not guess UI state. If selected state is hidden after a drawer, accordion, modal, or dropdown closes, reopen it or capture a visible chip/summary before treating it as verified.",
    "- If a site exposes a dedicated control for a requirement, use that control. A broad search query does not satisfy explicit filters, sorts, styles, attributes, or rankings.",
    "- Ranking words such as cheapest, latest, highest-rated, best-selling, or most reviewed must be grounded in the app's actual sort/filter or visible metric.",
    "- Numeric, date, quantity, and unit constraints must be exact. Wider buckets or broadened defaults are failures unless no exact control exists.",
    "- Empty results are acceptable only after the correct filters/actions were applied and evidenced.",
    "- For blocker claims, capture current evidence and only fail after repeated evidence from the actual UI.",
    "- If the same interaction (click, type, select) fails after 3 different targeting strategies (e.g. role, text, selector), call browser_snapshot to inspect the actual page structure. If the element is genuinely not clickable or not present, record the critical point as failed with the evidence, and either try a fundamentally different approach or finish the test. Do not keep cycling through selector variants — a real user who cannot tap a product card bounces immediately, so 3 failed attempts is a critical blocker, not a retry opportunity.",
    "- Only use the provided browser tools; do not change files or invoke external processes.",
    `- ${budgetInstruction}`,
    "- You must finish by calling finish_test with status and reason. Use passed only after all critical points are passed or otherwise proven by deterministic assertions.",
  ].join("\n");
}

function buildPrompt(input: { name: string; goal: string; baseUrl?: string; maxSteps?: number; hasInternetEgress?: boolean; corsBypassed?: boolean }) {
  return `You are running an agentic browser E2E test.\n\nTest name: ${input.name}\n\nGoal:\n${input.goal}\n\n${promptBody(input)}`;
}

function buildResumePrompt(input: {
  name: string;
  goal: string;
  baseUrl?: string;
  maxSteps?: number;
  hasInternetEgress?: boolean;
  corsBypassed?: boolean;
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

async function runWithWorkers<T, R>(
  items: T[],
  workers: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(workers, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await run(items[index]);
      }
    }),
  );

  return results;
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
