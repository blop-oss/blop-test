/**
 * Native browser-agent loop: a TypeScript port of khadim's agentic core,
 * executing blop's browser tools in-process (no native binary, no HTTP-RPC
 * tool bridge, no coding-agent modes).
 *
 * Ported from khadim (repo @ 2731483), file by file:
 * - LLM streaming request:  crates/khadim-ai-core/src/providers/openai_completions.rs
 * - SSE parsing:            crates/khadim-ai-core/src/streaming.rs (for_each_sse_event)
 * - Message/tool wire form: crates/khadim-ai-core/src/providers/transform_messages.rs
 * - Usage mapping:          crates/khadim-ai-core/src/providers/usage.rs
 * - Agent loop + events:    crates/khadim-coding-agent/src/agent/orchestrator.rs
 * - JSON repair:            crates/khadim-coding-agent/src/helpers.rs (try_repair_json)
 * - Provider base URLs:     crates/khadim-ai-core/src/env_api_keys.rs
 *
 * Deliberate deviations, each marked with a "blop:" comment at the site:
 * 1. Terminal tools — the loop stops once finish_test executes successfully,
 *    and a text-only reply mid-test gets a corrective nudge instead of ending
 *    the run (khadim ends the session on any text-only turn).
 * 2. History argument sanitization — tool-call arguments that arrive as
 *    invalid JSON are repaired before entering conversation history, so a
 *    mangled streamed call cannot poison every subsequent request (khadim
 *    replays the raw string and strict providers then 400 forever).
 * 3. Browser-specific system prompt — khadim's coding-mode prompt, PDDL mode
 *    planner, goal tracker, and contract extraction are not ported; the
 *    system prompt is a minimal browser preamble plus tool prompt snippets
 *    (mirroring runtime.rs build_prompt's snippet composition).
 * 4. Only the openai-completions wire protocol is ported. OpenRouter, OpenAI,
 *    Groq, xAI, Mistral, Cerebras, and NVIDIA all speak it; for Anthropic or
 *    Google models, route through OpenRouter.
 */
import type { NativeModelImage, NativeToolBridge } from "../browser/tools/types.js";
import type { BlopAgentStreamEvent, BlopAgentStreamRunner } from "./types.js";

// Port of RunConfig defaults (orchestrator.rs): max_turns 200, nudge_interval 6.
const MAX_TURNS = 200;
const NUDGE_INTERVAL = 6;
// blop: how many consecutive text-only replies to nudge past before giving up.
const MAX_TEXT_ONLY_NUDGES = 3;
// blop: tools whose successful execution ends the run (the test verdict).
const DEFAULT_TERMINAL_TOOLS = ["finish_test"];
// Port of orchestrator.rs retry loop: 3 attempts, 2^n-second backoff.
const MAX_LLM_RETRIES = 3;

// Port of env_api_keys.rs get_env_base_url defaults for openai-completions
// providers. BLOP_AGENT_BASE_URL overrides for any provider.
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  // Ollama Cloud serves an OpenAI-compatible API; a local server uses
  // http://localhost:11434/v1 (set BLOP_AGENT_BASE_URL to override).
  ollama: "https://ollama.com/v1",
};

type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string; detail: "auto" | "low" | "high" } }
          >;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls: ToolCall[];
      reasoning_content: string | null;
    }
  | { role: "tool"; content: string; tool_call_id: string };

type AssistantReply = {
  content: string;
  toolCalls: ToolCall[];
  reasoningContent: string | null;
};

type ToolExecResult = {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  metadata: Record<string, unknown> | null;
  modelImages: NativeModelImage[];
};

const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,/i;
const MAX_TOOL_IMAGES_PER_TURN = 5;

function validModelImages(images: NativeModelImage[] | undefined): NativeModelImage[] {
  if (!images) return [];
  return images
    .filter((image) => DATA_IMAGE_PATTERN.test(image.dataUrl))
    .slice(0, MAX_TOOL_IMAGES_PER_TURN);
}

export interface AgentLoopOptions {
  prompt: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  /** Unused; accepted for signature compatibility with the khadim wrapper. */
  cwd?: string;
  nativeTools: unknown[];
  signal?: AbortSignal;
  /**
   * Full system prompt to use verbatim. When set (e.g. the chat agent's prompt
   * or a subagent archetype prompt), it replaces the built-in browser preamble
   * — the loop is then a generic tool-calling agent, not browser-specific. When
   * absent, the loop falls back to the minimal browser system prompt.
   */
  systemPrompt?: string;
  /** blop: tools that end the run when they execute successfully. */
  terminalTools?: string[];
  /**
   * Hard cap on tool-call turns. Defaults to {@link MAX_TURNS} (200) for a
   * primary turn; subagents pass a small value (e.g. 12-16) so a delegated task
   * cannot run away. On reaching the cap the loop emits an error + done.
   */
  maxTurns?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to a real timer sleep. */
  sleepFn?: (ms: number) => Promise<void>;
}

function makeEvent(
  eventType: string,
  content?: string | null,
  metadata?: Record<string, unknown> | null,
): BlopAgentStreamEvent {
  // Port of events.rs AgentStreamEvent::new — blop runs are unscoped, so
  // workspace_id/session_id are null like khadim's unscoped events.
  return {
    workspace_id: null,
    session_id: null,
    event_type: eventType,
    content: content ?? null,
    metadata: metadata ?? null,
  };
}

/** Port of helpers.rs try_repair_json: string-aware brace/bracket balancing. */
export function tryRepairJson(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to repair
  }

  let inString = false;
  let escape = false;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (const ch of trimmed) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth -= 1;
      else if (ch === "[") bracketDepth += 1;
      else if (ch === "]") bracketDepth -= 1;
    }
  }

  let repaired = trimmed;
  if (inString) repaired += '"';
  for (let i = 0; i < bracketDepth; i += 1) repaired += "]";
  for (let i = 0; i < braceDepth; i += 1) repaired += "}";

  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

/**
 * blop: repair tool-call arguments before they enter conversation history.
 * Execution already salvages bad JSON (see executeSingleTool, mirroring
 * khadim's execute_single_tool); history must hold the same salvaged form,
 * otherwise the raw mangled string is replayed on every later request and
 * strict providers reject the whole conversation with HTTP 400.
 */
export function sanitizeToolCallArgs(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.map((toolCall) => {
    try {
      JSON.parse(toolCall.function.arguments);
      return toolCall;
    } catch {
      const repaired = tryRepairJson(toolCall.function.arguments);
      return {
        ...toolCall,
        function: {
          ...toolCall.function,
          arguments: repaired === undefined ? "{}" : JSON.stringify(repaired),
        },
      };
    }
  });
}

/** Port of transform_messages.rs normalize_tool_call_id. */
export function normalizeToolCallId(id: string, maxLen: number): string {
  const idPart = id.split("|")[0] ?? id;
  const sanitized = idPart.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.slice(0, maxLen);
}

/** Port of transform_messages.rs to_openai_messages (orphan flush included). */
export function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  const toolCallIdMap = new Map<string, string>();
  let pendingToolCalls: string[] = [];
  let existingToolResults = new Set<string>();

  const flushOrphanedToolResults = () => {
    for (const toolCallId of pendingToolCalls) {
      if (existingToolResults.has(toolCallId)) continue;
      converted.push({
        role: "tool",
        content: "No result provided",
        tool_call_id: toolCallId,
      });
    }
  };

  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      flushOrphanedToolResults();
      pendingToolCalls = [];
      existingToolResults = new Set();
      converted.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      flushOrphanedToolResults();
      pendingToolCalls = [];
      existingToolResults = new Set();

      const normalizedToolCalls = message.tool_calls.map((toolCall) => {
        const normalizedId = normalizeToolCallId(toolCall.id, 64);
        toolCallIdMap.set(toolCall.id, normalizedId);
        return { ...toolCall, id: normalizedId };
      });

      const assistantContent = message.content ?? "";
      if (!assistantContent.trim() && normalizedToolCalls.length === 0) continue;

      const value: Record<string, unknown> = {
        role: "assistant",
        content: assistantContent,
      };
      if (normalizedToolCalls.length > 0) {
        pendingToolCalls = normalizedToolCalls.map((toolCall) => toolCall.id);
        value.tool_calls = normalizedToolCalls;
      }
      // Some OpenAI-compatible reasoning providers require reasoning_content
      // on assistant tool-call messages even when no reasoning was streamed.
      if (message.reasoning_content !== null) {
        value.reasoning_content = message.reasoning_content;
      } else if (normalizedToolCalls.length > 0) {
        value.reasoning_content = "";
      }
      converted.push(value);
      continue;
    }

    // role === "tool"
    const normalizedId =
      toolCallIdMap.get(message.tool_call_id) ?? normalizeToolCallId(message.tool_call_id, 64);
    existingToolResults.add(normalizedId);
    converted.push({
      role: "tool",
      content: message.content,
      tool_call_id: normalizedId,
    });
  }

  flushOrphanedToolResults();
  return converted;
}

/** Port of transform_messages.rs to_openai_tools. */
function toOpenAiTools(tools: NativeToolBridge[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Port of usage.rs openai_completions_usage. */
function openAiCompletionsUsage(raw: Record<string, unknown>): Record<string, unknown> {
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  const totalInput = num(raw.prompt_tokens);
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheRead = num(details?.cached_tokens);
  return {
    input: Math.max(totalInput - cacheRead, 0),
    output: num(raw.completion_tokens),
    cache_read: cacheRead,
    cache_write: 0,
  };
}

/** Port of openai_completions.rs extract_reasoning_delta. */
function extractReasoningDelta(delta: Record<string, unknown>): string | undefined {
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
    const value = delta[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Port of openai_completions.rs choice_usage (per-choice usage fallback). */
function choiceUsage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const usage = (choices[0] as Record<string, unknown>).usage;
  return usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;
}

function resolveBaseUrl(provider: string): string {
  const override = process.env.BLOP_AGENT_BASE_URL?.trim();
  if (override) return override;
  const base = PROVIDER_BASE_URLS[provider];
  if (!base) {
    throw new Error(
      `Provider '${provider}' is not supported by blop's native agent loop ` +
        `(openai-completions wire only). Use one of: ${Object.keys(PROVIDER_BASE_URLS).join(", ")} ` +
        `— OpenRouter can route Anthropic/Google models — or set BLOP_AGENT_BASE_URL.`,
    );
  }
  return base;
}

/** Port of openai_completions.rs build_openai_headers (OpenRouter ranking headers). */
function buildHeaders(provider: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/unravel-ai/blop";
    headers["X-Title"] = "Blop";
  }
  return headers;
}

/**
 * Port of openai_completions.rs stream() + streaming.rs for_each_sse_event,
 * with the orchestrator's AssistantStreamEvent→AgentStreamEvent mapping
 * (orchestrator.rs run loop closure) folded in: this generator yields the
 * mapped events directly and returns the assembled reply.
 */
async function* streamChatCompletion(input: {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  messages: ChatMessage[];
  tools: NativeToolBridge[];
  turnIndex: number;
  signal?: AbortSignal;
  fetchFn: typeof fetch;
}): AsyncGenerator<BlopAgentStreamEvent, AssistantReply> {
  const payload = {
    model: input.model,
    messages: toOpenAiMessages(input.messages),
    tools: toOpenAiTools(input.tools),
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
    // khadim omits temperature for reasoning-capable models; unknown models
    // resolve as reasoning (models.rs base_model is_reasoning=true), so runs
    // through khadim never sent temperature. Mirror that.
  };

  const response = await input.fetchFn(`${input.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: input.headers,
    body: JSON.stringify(payload),
    signal: input.signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM streaming request failed: HTTP ${response.status} - ${body}`);
  }
  if (!response.body) {
    throw new Error("LLM streaming request returned no body");
  }

  const thinkingId = `llm-thinking-${input.turnIndex}`;
  const thinkingMeta = { id: thinkingId, title: "Thinking", tool: "model" };

  let finalContent = "";
  let finalReasoning = "";
  const toolCalls: ToolCall[] = [];
  const partialToolCalls = new Map<number, ToolCall>();

  const events: BlopAgentStreamEvent[] = [];

  const handleData = (data: string) => {
    if (data === "[DONE]") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Failed to parse LLM streaming event: ${String(error)}`);
    }

    const rawUsage =
      (parsed.usage as Record<string, unknown> | undefined) ?? choiceUsage(parsed);
    if (rawUsage) {
      events.push(makeEvent("usage", null, openAiCompletionsUsage(rawUsage)));
    }

    const choices = parsed.choices;
    const choice =
      Array.isArray(choices) && choices.length > 0
        ? (choices[0] as Record<string, unknown>)
        : undefined;
    if (!choice) return;

    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const content = delta.content;
    if (typeof content === "string" && content.length > 0) {
      finalContent += content;
      events.push(makeEvent("text_delta", content));
    }

    const reasoning = extractReasoningDelta(delta);
    if (reasoning) {
      if (!finalReasoning) {
        events.push(makeEvent("step_start", "Thinking", thinkingMeta));
      }
      finalReasoning += reasoning;
      events.push(makeEvent("step_update", reasoning, thinkingMeta));
    }

    const deltaCalls = delta.tool_calls;
    if (Array.isArray(deltaCalls)) {
      for (const rawCall of deltaCalls) {
        const call = rawCall as Record<string, unknown>;
        const index = typeof call.index === "number" ? call.index : partialToolCalls.size;
        let entry = partialToolCalls.get(index);
        if (!entry) {
          entry = { id: "", type: "function", function: { name: "", arguments: "" } };
          partialToolCalls.set(index, entry);
        }

        const hadId = entry.id.length > 0;
        if (typeof call.id === "string" && !hadId) {
          entry.id = call.id;
        }

        const fn = call.function as Record<string, unknown> | undefined;
        if (typeof fn?.name === "string" && !entry.function.name) {
          entry.function.name = fn.name;
        }

        if (!hadId && entry.id) {
          events.push(
            makeEvent("step_start", `Preparing ${entry.function.name}`, {
              id: entry.id,
              title: `Preparing ${entry.function.name}`,
              tool: entry.function.name,
            }),
          );
        }

        if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
          entry.function.arguments += fn.arguments;
          events.push(
            makeEvent("step_update", fn.arguments, {
              id: entry.id,
              title: `Preparing ${entry.function.name}`,
              tool: entry.function.name,
            }),
          );
        }
      }
    }

    if (typeof choice.finish_reason === "string") {
      for (const entry of [...partialToolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value)) {
        events.push(
          makeEvent("step_update", entry.function.arguments, {
            id: entry.id,
            title: `Preparing ${entry.function.name}`,
            tool: entry.function.name,
          }),
        );
        toolCalls.push(entry);
      }
      partialToolCalls.clear();
    }
  };

  // Port of streaming.rs for_each_sse_event: split on blank lines, strip
  // "data:" prefixes, join multi-line data blocks.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const processBlock = (raw: string) => {
    const data = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (data.length > 0) handleData(data.join("\n"));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        processBlock(raw);
        for (const event of events.splice(0)) yield event;
        index = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) {
      processBlock(buffer);
    }
    for (const event of events.splice(0)) yield event;
  } finally {
    reader.releaseLock();
  }

  if (finalReasoning) {
    yield makeEvent("step_complete", finalReasoning, thinkingMeta);
  }

  return {
    content: finalContent,
    toolCalls,
    reasoningContent: finalReasoning || null,
  };
}

/** Port of orchestrator.rs execute_single_tool: resolve → run → events → result. */
async function* executeSingleTool(
  toolCall: ToolCall,
  tools: Map<string, NativeToolBridge>,
): AsyncGenerator<BlopAgentStreamEvent, ToolExecResult> {
  const stepId = toolCall.id;
  const toolName = toolCall.function.name;
  const rawArgs = toolCall.function.arguments;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    const repaired = tryRepairJson(rawArgs);
    args =
      repaired && typeof repaired === "object" && !Array.isArray(repaired)
        ? (repaired as Record<string, unknown>)
        : {};
  }

  yield makeEvent("step_start", `Running ${toolName}`, {
    id: stepId,
    title: `Running ${toolName}`,
    tool: toolName,
  });

  const tool = tools.get(toolName);
  if (!tool) {
    const message = `Requested tool is not available: ${toolName}`;
    yield makeEvent("step_complete", message, {
      id: stepId,
      title: `Completed ${toolName}`,
      tool: toolName,
      result: message,
      is_error: true,
    });
    return {
      toolCallId: stepId,
      toolName,
      content: "Tool not available",
      isError: true,
      metadata: null,
      modelImages: [],
    };
  }

  try {
    const result = await tool.execute(args);
    const stepMeta: Record<string, unknown> = {
      id: stepId,
      title: `Completed ${toolName}`,
      tool: toolName,
      result: result.content,
      is_error: false,
    };
    if (result.metadata) {
      for (const [key, value] of Object.entries(result.metadata)) {
        stepMeta[key] = value;
      }
    }
    yield makeEvent("step_complete", result.content, stepMeta);
    return {
      toolCallId: stepId,
      toolName,
      content: result.content,
      isError: false,
      metadata: result.metadata ?? null,
      modelImages: validModelImages(result.modelImages),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield makeEvent("step_complete", message, {
      id: stepId,
      title: `Completed ${toolName}`,
      tool: toolName,
      result: message,
      is_error: true,
    });
    return {
      toolCallId: stepId,
      toolName,
      content: `Error: ${message}`,
      isError: true,
      metadata: null,
      modelImages: [],
    };
  }
}

/**
 * blop: a tool result ends the run when its tool is in terminalTools and it
 * executed without error, or when the result metadata carries terminal: true.
 */
function isTerminalResult(result: ToolExecResult, terminalTools: string[]): boolean {
  if (result.metadata?.terminal === true) return true;
  return !result.isError && terminalTools.includes(result.toolName);
}

/** Port of orchestrator.rs progress_nudge. */
function progressNudge(turnIndex: number): string {
  return (
    `Progress checkpoint after ${turnIndex} turns. Reduce the search space before continuing: ` +
    "restate the exact success contract, keep at most 3 live hypotheses, pick the cheapest next " +
    "experiment, and verify an artifact or command soon. If a needed tool is missing, install it " +
    "or choose a different branch immediately."
  );
}

/** blop: corrective nudge for a text-only turn mid-test. */
function terminalNudge(terminalTools: string[], lookedLikeToolCall: boolean): string {
  const tools = terminalTools.join(", ");
  if (lookedLikeToolCall) {
    return (
      "Your last message wrote a tool call as plain text, so nothing was executed. " +
      "Tool calls only work through the tool-calling interface, never as message text. " +
      `Re-issue the call properly now. The task only completes when you call: ${tools}.`
    );
  }
  return (
    "Your last message contained no tool call, so the task is still unfinished. " +
    "Continue working using tool calls only, and when the goal is complete or blocked, " +
    `call: ${tools}.`
  );
}

/** blop: detect tool calls serialized into the text channel by drifting models. */
export function looksLikeTextualToolCall(content: string): boolean {
  return /<\|?\/?tool_call\b|\bcall:[a-z_]+\s*\{/i.test(content);
}

/**
 * blop: minimal browser-agent system prompt — the runner's buildPrompt output
 * (test name, goal, rules) arrives as the user message, exactly as it did
 * through khadim. Tool prompt snippets are composed the way khadim's
 * runtime.rs build_prompt composes them.
 */
function buildSystemPrompt(tools: NativeToolBridge[]): string {
  const snippets = tools.map((tool) => tool.promptSnippet ?? `- ${tool.name}: ${tool.description}`);
  return (
    "You are a browser automation agent executing an agentic end-to-end test. " +
    "You act exclusively by calling the provided tools through the tool-calling " +
    "interface; plain text never operates the browser.\n\nAvailable tools:\n" +
    snippets.join("\n")
  );
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The agent loop. Port of orchestrator.rs run_prompt_with_runtime, minus the
 * mode planner / goal tracker / contract extraction (coding-agent features),
 * plus the terminal-tool and nudge policies described in the header.
 *
 * Signature matches BlopAgentStreamRunner so the runner can use it as a
 * drop-in default for the khadim wrapper.
 */
export const runBrowserAgentStream: BlopAgentStreamRunner = async function* (options) {
  const opts = options as AgentLoopOptions;
  const provider = opts.provider?.trim() || "openrouter";
  const model = opts.model?.trim();
  const apiKey = opts.apiKey?.trim();
  if (!model) throw new Error("No model configured for the blop agent loop");
  if (!apiKey) throw new Error(`Missing API key for provider '${provider}'`);

  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const terminalTools = opts.terminalTools ?? DEFAULT_TERMINAL_TOOLS;
  const maxTurns = opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : MAX_TURNS;
  const tools = (opts.nativeTools as NativeToolBridge[]) ?? [];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  const baseUrl = resolveBaseUrl(provider);
  const headers = buildHeaders(provider, apiKey);

  const systemPrompt = opts.systemPrompt?.trim() || buildSystemPrompt(tools);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.prompt },
  ];

  let turnIndex = 0;
  let textOnlyNudges = 0;

  while (true) {
    if (opts.signal?.aborted) return;

    if (turnIndex >= maxTurns) {
      yield makeEvent("error", `Reached maximum turn limit (${maxTurns}). Stopping.`);
      yield makeEvent("done");
      return;
    }
    // blop: khadim pushes nudges as mid-conversation system messages, but
    // strict OpenAI-compatible backends reject those ("System message must
    // be at the beginning"), so harness nudges are user messages here.
    if (NUDGE_INTERVAL > 0 && turnIndex > 0 && turnIndex % NUDGE_INTERVAL === 0) {
      messages.push({ role: "user", content: progressNudge(turnIndex) });
    }

    // Port of the orchestrator's LLM retry loop: 3 attempts, exponential
    // backoff, llm_call_start/llm_call_end around every attempt.
    let reply: AssistantReply | null = null;
    let retryCount = 0;
    while (reply === null) {
      yield makeEvent("llm_call_start");
      try {
        reply = yield* streamChatCompletion({
          baseUrl,
          headers,
          model,
          messages,
          tools,
          turnIndex,
          signal: opts.signal,
          fetchFn,
        });
        yield makeEvent("llm_call_end");
      } catch (error) {
        yield makeEvent("llm_call_end");
        if (opts.signal?.aborted) return;
        retryCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (retryCount >= MAX_LLM_RETRIES) {
          throw error instanceof Error ? error : new Error(message);
        }
        yield makeEvent("error", `LLM error (retry ${retryCount}/${MAX_LLM_RETRIES}): ${message}`);
        await sleepFn(2 ** retryCount * 1000);
      }
    }

    if (reply.toolCalls.length > 0) {
      textOnlyNudges = 0;
      messages.push({
        role: "assistant",
        content: reply.content.trim() ? reply.content : null,
        // blop: history gets repaired-JSON arguments (deviation 2).
        tool_calls: sanitizeToolCallArgs(reply.toolCalls),
        reasoning_content: reply.reasoningContent,
      });

      // Port of execute_tool_calls: blop's browser tools are stateful, so all
      // run sequentially (none are in khadim's PARALLEL_SAFE_TOOLS either).
      let reachedTerminal = false;
      const modelImages: Array<NativeModelImage & { toolName: string }> = [];
      for (const toolCall of reply.toolCalls) {
        const result = yield* executeSingleTool(toolCall, toolMap);
        messages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.toolCallId,
        });
        for (const image of result.modelImages) {
          if (modelImages.length >= MAX_TOOL_IMAGES_PER_TURN) break;
          modelImages.push({ ...image, toolName: result.toolName });
        }
        if (isTerminalResult(result, terminalTools)) reachedTerminal = true;
        if (opts.signal?.aborted) return;
      }

      if (modelImages.length > 0) {
        messages.push({
          role: "user",
          content: modelImages.flatMap((image) => [
            {
              type: "text" as const,
              text: `Visual evidence from ${image.toolName}: ${image.caption ?? "Screenshot"}`,
            },
            {
              type: "image_url" as const,
              image_url: { url: image.dataUrl, detail: image.detail ?? "auto" },
            },
          ]),
        });
      }

      // blop: the verdict landed — stop instead of letting the model keep
      // stepping past finish_test (deviation 1).
      if (reachedTerminal) {
        yield makeEvent("done");
        return;
      }

      turnIndex += 1;
      continue;
    }

    // Text-only reply. khadim ends the session here; blop nudges the agent
    // back into the tool-calling interface while the test is unfinished
    // (deviation 1), bounded so a hopeless model still terminates.
    if (terminalTools.length > 0 && textOnlyNudges < MAX_TEXT_ONLY_NUDGES) {
      textOnlyNudges += 1;
      if (reply.content.trim() || reply.reasoningContent) {
        messages.push({
          role: "assistant",
          content: reply.content.trim() ? reply.content : null,
          tool_calls: [],
          reasoning_content: reply.reasoningContent,
        });
      }
      const nudge = terminalNudge(terminalTools, looksLikeTextualToolCall(reply.content));
      // blop: user role, not system — see the progress-nudge comment above.
      messages.push({ role: "user", content: nudge });
      yield makeEvent(
        "system_message",
        `Agent replied without a tool call; nudging it to continue (${textOnlyNudges}/${MAX_TEXT_ONLY_NUDGES}).`,
      );
      turnIndex += 1;
      continue;
    }

    if (reply.content.trim() || reply.reasoningContent) {
      messages.push({
        role: "assistant",
        content: reply.content.trim() ? reply.content : null,
        tool_calls: [],
        reasoning_content: reply.reasoningContent,
      });
    }
    yield makeEvent("done");
    return;
  }
};

/**
 * Generic in-process agent loop — the same implementation as
 * runBrowserAgentStream, exposed under a neutral name and typed to accept the
 * full {@link AgentLoopOptions} so non-browser callers (the in-app chat agent
 * and its subagents) can drive an agent turn directly, with no native binary
 * and no `--prompt` argv ceiling. Pass `terminalTools: []` for a conversational
 * agent (a text reply ends the turn) and a `systemPrompt` to replace the
 * browser preamble.
 */
export function runNativeAgentStream(
  options: AgentLoopOptions,
): AsyncGenerator<BlopAgentStreamEvent> {
  return runBrowserAgentStream(options) as AsyncGenerator<BlopAgentStreamEvent>;
}
