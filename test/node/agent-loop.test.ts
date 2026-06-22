import { describe, expect, test } from "bun:test";
import {
  looksLikeTextualToolCall,
  normalizeToolCallId,
  runBrowserAgentStream,
  sanitizeToolCallArgs,
  toOpenAiMessages,
  tryRepairJson,
} from "../../src/runtime/agent-loop";
import type { BlopAgentStreamEvent } from "../../src/runtime/types";

function sseResponse(events: Array<Record<string, unknown> | string>): Response {
  const body = `${events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
    .join("\n\n")}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function toolCallTurn(name: string, args: string, id = `call_${name}`): Response {
  return sseResponse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, function: { name, arguments: "" } }],
          },
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);
}

function textTurn(text: string): Response {
  return sseResponse([
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
}

function makeHarness(responses: Response[]) {
  const requests: Array<Record<string, unknown>> = [];
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error("mock fetch exhausted");
    return next;
  }) as typeof fetch;

  const tools = [
    {
      name: "browser_goto",
      description: "Navigate",
      parameters: { type: "object", properties: { url: { type: "string" } } },
      promptSnippet: "- browser_goto: navigate to a URL",
      execute: async (input: Record<string, unknown>) => {
        executed.push({ name: "browser_goto", input });
        return { content: `Navigated to ${String(input.url)}` };
      },
    },
    {
      name: "finish_test",
      description: "Finish",
      parameters: { type: "object", properties: { status: { type: "string" } } },
      promptSnippet: "- finish_test: end the test",
      execute: async (input: Record<string, unknown>) => {
        executed.push({ name: "finish_test", input });
        return { content: `${String(input.status)}: ${String(input.reason ?? "")}` };
      },
    },
  ];

  return { requests, executed, fetchFn, tools };
}

async function collect(
  responses: Response[],
  extra: { sleeps?: number[] } = {},
): Promise<{
  events: BlopAgentStreamEvent[];
  requests: Array<Record<string, unknown>>;
  executed: Array<{ name: string; input: Record<string, unknown> }>;
}> {
  const harness = makeHarness(responses);
  const events: BlopAgentStreamEvent[] = [];
  for await (const event of runBrowserAgentStream({
    prompt: "Goal: verify example.com",
    provider: "openrouter",
    model: "test/model",
    apiKey: "key",
    nativeTools: harness.tools,
    // Extra loop options consumed by AgentLoopOptions.
    ...({
      fetchFn: harness.fetchFn,
      sleepFn: async (ms: number) => {
        extra.sleeps?.push(ms);
      },
    } as Record<string, unknown>),
  })) {
    events.push(event);
  }
  return { events, requests: harness.requests, executed: harness.executed };
}

describe("runBrowserAgentStream", () => {
  test("attaches tool-provided image evidence to the next model turn", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      toolCallTurn("inspect_run", "{}"),
      toolCallTurn("finish_test", JSON.stringify({ status: "passed", reason: "reviewed" })),
    ];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift()!;
    }) as typeof fetch;
    const tools = [
      {
        name: "inspect_run",
        description: "Inspect a run",
        parameters: { type: "object", properties: {} },
        promptSnippet: "- inspect_run: inspect evidence",
        execute: async () => ({
          content: "Two screenshots are attached.",
          modelImages: [
            {
              dataUrl: "data:image/png;base64,aGVsbG8=",
              caption: "Homepage after navigation",
            },
          ],
        }),
      },
      {
        name: "finish_test",
        description: "Finish",
        parameters: { type: "object", properties: {} },
        promptSnippet: "- finish_test: finish",
        execute: async () => ({ content: "passed" }),
      },
    ];

    for await (const _event of runBrowserAgentStream({
      prompt: "Review the run",
      provider: "openrouter",
      model: "test/model",
      apiKey: "key",
      nativeTools: tools,
      ...({ fetchFn } as Record<string, unknown>),
    })) {
      // drain
    }

    const secondMessages = requests[1].messages as Array<Record<string, unknown>>;
    const evidence = secondMessages.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    ) as { content: Array<Record<string, unknown>> } | undefined;
    expect(evidence?.content).toEqual([
      { type: "text", text: "Visual evidence from inspect_run: Homepage after navigation" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
      },
    ]);
  });

  test("executes tool calls in-process and stops once finish_test succeeds", async () => {
    const { events, requests, executed } = await collect([
      toolCallTurn("browser_goto", JSON.stringify({ url: "https://example.com" })),
      toolCallTurn("finish_test", JSON.stringify({ status: "passed", reason: "done" })),
    ]);

    expect(executed.map((entry) => entry.name)).toEqual(["browser_goto", "finish_test"]);
    // Stopped at the verdict: exactly two LLM requests, no third turn.
    expect(requests).toHaveLength(2);
    expect(events.at(-1)?.event_type).toBe("done");
    const stepStarts = events.filter((event) => event.event_type === "step_start");
    expect(stepStarts.map((event) => event.content)).toContain("Running browser_goto");

    // The second request replays the tool result in OpenAI wire format.
    const secondMessages = requests[1].messages as Array<Record<string, unknown>>;
    const toolMessage = secondMessages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content)).toContain("Navigated to https://example.com");
    expect(requests[0].tool_choice).toBe("auto");
    const system = secondMessages[0] as { role: string; content: string };
    expect(system.role).toBe("system");
    expect(system.content).toContain("- browser_goto: navigate to a URL");
  });

  test("nudges past a text-only turn instead of ending the run", async () => {
    const { events, requests, executed } = await collect([
      textTurn("Let me continue exploring the page."),
      toolCallTurn("finish_test", JSON.stringify({ status: "passed", reason: "done" })),
    ]);

    expect(executed.map((entry) => entry.name)).toEqual(["finish_test"]);
    expect(events.some((event) => event.event_type === "system_message")).toBe(true);
    const secondMessages = requests[1].messages as Array<Record<string, unknown>>;
    const nudge = secondMessages.filter((message) => message.role === "user").at(-1);
    expect(String(nudge?.content)).toContain("contained no tool call");
    expect(events.at(-1)?.event_type).toBe("done");
  });

  test("recognizes tool calls written as text and nudges with the format correction", async () => {
    const { requests } = await collect([
      textTurn('<|tool_call>call:finish_test{status:<|"|>passed<|"|>}'),
      toolCallTurn("finish_test", JSON.stringify({ status: "passed", reason: "done" })),
    ]);

    const secondMessages = requests[1].messages as Array<Record<string, unknown>>;
    const nudge = secondMessages.filter((message) => message.role === "user").at(-1);
    expect(String(nudge?.content)).toContain("wrote a tool call as plain text");
  });

  test("gives up after the nudge budget and ends the run", async () => {
    const { events, requests } = await collect([
      textTurn("thinking..."),
      textTurn("still thinking..."),
      textTurn("hmm..."),
      textTurn("I am done."),
    ]);

    expect(requests).toHaveLength(4);
    expect(events.at(-1)?.event_type).toBe("done");
  });

  test("repairs mangled tool-call arguments for execution and history", async () => {
    const { requests, executed } = await collect([
      // Unterminated JSON: the stream died mid-arguments.
      toolCallTurn("browser_goto", '{"url": "https://example.com'),
      toolCallTurn("finish_test", JSON.stringify({ status: "passed", reason: "done" })),
    ]);

    // Execution salvages the arguments (khadim try_repair_json semantics).
    expect(executed[0]?.input).toEqual({ url: "https://example.com" });
    // History holds valid JSON, so the next request cannot be poisoned.
    const secondMessages = requests[1].messages as Array<Record<string, unknown>>;
    const assistant = secondMessages.find(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
    ) as { tool_calls: Array<{ function: { arguments: string } }> };
    expect(() => JSON.parse(assistant.tool_calls[0].function.arguments)).not.toThrow();
  });

  test("retries LLM errors with backoff and surfaces them as error events", async () => {
    const sleeps: number[] = [];
    const { events, executed } = await collect(
      [
        new Response("upstream exploded", { status: 500 }),
        toolCallTurn("finish_test", JSON.stringify({ status: "passed", reason: "done" })),
      ],
      { sleeps },
    );

    expect(executed.map((entry) => entry.name)).toEqual(["finish_test"]);
    const errorEvent = events.find((event) => event.event_type === "error");
    expect(String(errorEvent?.content)).toContain("LLM error (retry 1/3)");
    expect(String(errorEvent?.content)).toContain("HTTP 500");
    expect(sleeps).toEqual([2000]);
  });

  test("throws after exhausting LLM retries", async () => {
    const harness = makeHarness([
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
      new Response("boom", { status: 500 }),
    ]);
    const run = async () => {
      for await (const _event of runBrowserAgentStream({
        prompt: "Goal",
        provider: "openrouter",
        model: "test/model",
        apiKey: "key",
        nativeTools: harness.tools,
        ...({ fetchFn: harness.fetchFn, sleepFn: async () => {} } as Record<string, unknown>),
      })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow("HTTP 500");
  });

  test("reports an unavailable tool as an error result and keeps going", async () => {
    const { events, requests } = await collect([
      toolCallTurn("browser_teleport", "{}"),
      toolCallTurn("finish_test", JSON.stringify({ status: "passed", reason: "done" })),
    ]);

    const completes = events.filter((event) => event.event_type === "step_complete");
    expect(
      completes.some((event) =>
        String(event.content).includes("Requested tool is not available: browser_teleport"),
      ),
    ).toBe(true);
    const secondMessages = requests[1].messages as Array<Record<string, unknown>>;
    const toolMessage = secondMessages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content)).toBe("Tool not available");
  });
});

describe("ported helpers", () => {
  test("tryRepairJson balances unterminated strings and braces (helpers.rs port)", () => {
    expect(tryRepairJson('{"a": "b"}')).toEqual({ a: "b" });
    expect(tryRepairJson('{"a": "b')).toEqual({ a: "b" });
    expect(tryRepairJson('{"a": ["b"')).toEqual({ a: ["b"] });
    expect(tryRepairJson("")).toBeUndefined();
    expect(tryRepairJson("not json at all")).toBeUndefined();
  });

  test("sanitizeToolCallArgs leaves valid JSON untouched and repairs the rest", () => {
    const valid = {
      id: "a",
      type: "function",
      function: { name: "x", arguments: '{"k":1}' },
    };
    const broken = {
      id: "b",
      type: "function",
      function: { name: "y", arguments: '{"k": "v' },
    };
    const [first, second] = sanitizeToolCallArgs([valid, broken]);
    expect(first.function.arguments).toBe('{"k":1}');
    expect(JSON.parse(second.function.arguments)).toEqual({ k: "v" });
  });

  test("normalizeToolCallId strips pipe suffixes and special characters", () => {
    expect(normalizeToolCallId("call_1|AAAA++//==BBBB", 64)).toBe("call_1");
    expect(normalizeToolCallId("call+1", 64)).toBe("call_1");
    expect(normalizeToolCallId("x".repeat(100), 64)).toHaveLength(64);
  });

  test("looksLikeTextualToolCall matches drifted formats", () => {
    expect(looksLikeTextualToolCall("<|tool_call>call:finish_test{")).toBe(true);
    expect(looksLikeTextualToolCall("call:browser_goto {")).toBe(true);
    expect(looksLikeTextualToolCall("just narrating the plan")).toBe(false);
  });

  test("toOpenAiMessages flushes orphaned tool calls (transform_messages.rs port)", () => {
    const wire = toOpenAiMessages([
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }],
        reasoning_content: null,
      },
      // No tool result recorded for call_1: next user turn must flush it.
      { role: "user", content: "continue" },
    ]);
    const orphan = wire.find((message) => message.role === "tool");
    expect(orphan).toEqual({
      role: "tool",
      content: "No result provided",
      tool_call_id: "call_1",
    });
    const assistant = wire.find((message) => message.role === "assistant") as Record<
      string,
      unknown
    >;
    expect(assistant.reasoning_content).toBe("");
  });
});
