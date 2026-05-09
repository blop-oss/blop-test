import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAgentStream } from "@unravelai/khadim";
import { chromium, firefox, webkit } from "playwright";
import { createBrowserTools, type FinishState } from "../browser/tools.js";
import { getCiMetadata } from "../node/ci.js";
import { uploadRunToPlatform } from "../platform/upload.js";
import { writeReports } from "../reporters/index.js";
import { loadAgentTests } from "./spec.js";
import type { BlopAgentEvent, BlopRunOptions, BlopRunResult, BlopTestResult, BlopTestStatus } from "./types.js";

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

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    const browserType = { chromium, firefox, webkit }[options.browser ?? "chromium"];
    browser = await browserType.launch({ headless: !options.headed });

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
              actions: [],
              events: [],
            });
            continue;
          }

          const actions: BlopTestResult["actions"] = [];
          const screenshots: string[] = [];
          const events: BlopAgentEvent[] = [];
          const testStartedAt = new Date();
          let status: BlopTestStatus = "error";
          let reason = "The agent did not finish the test.";
          let attempts = 0;

          for (let attempt = 1; attempt <= (options.retries ?? 0) + 1; attempt += 1) {
            attempts = attempt;
            let context;
            try {
              context = await browser.newContext({
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
            const finishState: FinishState = { status: null, reason: null };
            const controller = new AbortController();
            const timeoutMs = test.timeoutMs ?? options.timeoutMs;
            const timeout = timeoutMs
              ? setTimeout(() => controller.abort(new Error(`Test timed out after ${timeoutMs}ms`)), timeoutMs)
              : null;

            try {
              const nativeTools = await createBrowserTools({
                page,
                testId,
                screenshotDir: screenshotsDir,
                actions,
                screenshots,
                finishState,
                baseUrl: test.baseUrl ?? options.baseUrl,
              });

              const prompt = buildPrompt({
                name: test.name,
                goal: test.goal,
                baseUrl: test.baseUrl ?? options.baseUrl,
                maxSteps: options.maxSteps ?? 25,
              });

              let stepCount = 0;
              const agentStream = options.agentStream ?? runAgentStream;
              for await (const event of agentStream({
                prompt,
                provider: options.provider ?? process.env.BLOP_AGENT_PROVIDER,
                model: options.model ?? process.env.BLOP_AGENT_MODEL,
                apiKey: options.apiKey ?? process.env.BLOP_AGENT_API_KEY,
                cwd: options.cwd ?? process.cwd(),
                nativeTools,
                signal: controller.signal,
              })) {
                if (controller.signal.aborted) {
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

                if (stepCount > (options.maxSteps ?? 25)) {
                  const resolvedProvider = options.provider ?? process.env.BLOP_AGENT_PROVIDER;
                  const hasApiKey = !!(options.apiKey ?? process.env.BLOP_AGENT_API_KEY);
                  const hint = !hasApiKey
                    ? `\n\nNo API key is configured. Set one via:\n  BLOP_AGENT_API_KEY=sk-...\n  ${providerEnvHint(resolvedProvider)}\n  --api-key sk-...\n  blop.config.ts: apiKey: 'sk-...'`
                    : "\n\nTry increasing --max-steps or check that the agent provider and model are correctly configured.";
                  throw new Error(`Agent exceeded max step count of ${options.maxSteps ?? 25}${hint}`);
                }
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
                const hasApiKey = !!(options.apiKey ?? process.env.BLOP_AGENT_API_KEY);
                status = "error";
                reason = `The agent produced ${events.length} event(s) but made no tool calls — the agent could not interact with the browser.\n\n`;
                if (!hasApiKey) {
                  reason += `No API key is configured. Set one via:\n  BLOP_AGENT_API_KEY=sk-...\n  ${providerEnvHint(resolvedProvider)}\n  --api-key sk-...\n  blop.config.ts: apiKey: 'sk-...'\n\n`;
                }
                reason += "Check that the provider and model are correctly configured and the API key is valid.";
                break;
              }

              status = finishState.status ?? "failed";
              reason = finishState.reason ?? reason;
              if (status === "passed" || attempt > (options.retries ?? 0)) break;
            } catch (error) {
              status = "error";
              reason = error instanceof Error ? error.message : String(error);
              if (hasLiveAgent && reason.includes("API key")) {
                reason = `${reason}\n\nHint: Set the BLOP_AGENT_API_KEY environment variable, the --api-key CLI flag, or the apiKey field in blop.config.ts.`;
              }
              if (attempt > (options.retries ?? 0)) break;
            } finally {
              if (timeout) clearTimeout(timeout);
              try {
                await context.close();
              } catch {
                // Context may already be closed or browser crashed.
              }
            }
          }

          const testFinishedAt = new Date();
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
            actions,
            events,
          });
        }
      }
    } finally {
      try {
        await browser?.close();
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

function providerEnvHint(provider: string | undefined): string {
  const envVar = provider
    ? ({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY", groq: "GROQ_API_KEY", xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY", mistral: "MISTRAL_API_KEY", cerebras: "CEREBRAS_API_KEY", nvidia: "NVIDIA_API_KEY" } as Record<string, string>)[provider]
    : null;
  return envVar ? `${envVar}=sk-...` : "OPENAI_API_KEY=sk-... or ANTHROPIC_API_KEY=sk-ant-...";
}

function buildPrompt(input: { name: string; goal: string; baseUrl?: string; maxSteps: number }) {
  const startInstruction = input.baseUrl
    ? `The app base URL is ${input.baseUrl}. Resolve relative URLs in the goal against this base URL.`
    : "If the goal requires a URL, use browser_goto with the URL supplied by the test.";

  return `You are running an agentic browser E2E test.\n\nTest name: ${input.name}\n\nGoal:\n${input.goal}\n\nRules:\n- ${startInstruction}\n- Use browser_snapshot before deciding important actions.\n- Prefer deterministic assertions with browser_expect_text.\n- Capture a screenshot for important success or failure evidence.\n- Do not modify files or run shell commands.\n- Stay within ${input.maxSteps} tool steps.\n- You must finish by calling finish_test with status and reason.\n`;
}

function summarizeStatus(results: BlopTestResult[]): BlopTestStatus {
  if (results.some((result) => result.status === "error")) return "error";
  if (results.some((result) => result.status === "failed")) return "failed";
  return "passed";
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
