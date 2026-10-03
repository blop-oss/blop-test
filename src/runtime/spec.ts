import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { BlopAgent, BlopAgentStep, BlopAgentTest, BlopAgentTestHandler } from "./types.js";

const agentTestSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

type RegisteredAgentTest = {
  name: string;
  handler: BlopAgentTestHandler;
};

const registryKey = Symbol.for("blop.agentTests");
const describeStackKey = Symbol.for("blop.describeStack");
const globalRegistry = globalThis as typeof globalThis & {
  [registryKey]?: RegisteredAgentTest[];
  [describeStackKey]?: string[];
};

const registeredTests = globalRegistry[registryKey] ??= [];
const describeStack = globalRegistry[describeStackKey] ??= [];
let specImportSequence = 0;
const registeredBySpec = new Map<string, { module: unknown; tests: RegisteredAgentTest[] }>();

export function defineAgentTest(test: BlopAgentTest): BlopAgentTest {
  return agentTestSchema.parse(test);
}

export function describe(name: string, fn: () => void): void {
  describeStack.push(name);
  try {
    fn();
  } finally {
    describeStack.pop();
  }
}

export function agentTest(name: string, handler: BlopAgentTestHandler): void {
  registeredTests.push({
    name: [...describeStack, name].join(" > "),
    handler,
  });
}

export async function loadAgentTests(specFile: string): Promise<BlopAgentTest[]> {
  const startIndex = registeredTests.length;
  const url = pathToFileURL(specFile);
  // The spec is runtime-selected; a fresh URL reloads authored code under Node.
  url.searchParams.set("blopLoad", String(++specImportSequence));
  const mod = await import(url.href);
  let registered = registeredTests.splice(startIndex);
  const cached = registeredBySpec.get(specFile);
  // Bun may return the same module despite a new query; retain that module's DSL handlers.
  if (cached && cached.module === mod && registered.length === 0) registered = cached.tests;
  else registeredBySpec.set(specFile, { module: mod, tests: registered });
  const tests = await Promise.all(registered.map(materializeRegisteredTest));
  const seen = new Set<unknown>();
  const add = (value: unknown) => {
    if (seen.has(value)) return;
    seen.add(value);
    tests.push(agentTestSchema.parse(value));
  };
  for (const key of ["default", "tests"]) {
    const value = mod[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach(add);
    else add(value);
  }
  for (const [key, value] of Object.entries(mod)) {
    if (key === "default" || key === "tests" || !Array.isArray(value)) continue;
    if (value.every(test => test !== null && typeof test === "object" && "name" in test && "goal" in test)) value.forEach(add);
  }
  return tests;
}

async function materializeRegisteredTest(test: RegisteredAgentTest): Promise<BlopAgentTest> {
  const steps: BlopAgentStep[] = [];
  const agent: BlopAgent = {
    goto: async (url) => {
      steps.push({ type: "goto", url });
    },
    goal: async (goal) => {
      steps.push({ type: "goal", goal });
    },
  };

  await test.handler({ agent });

  return agentTestSchema.parse({
    name: test.name,
    goal: stepsToGoal(steps),
  });
}

function stepsToGoal(steps: BlopAgentStep[]) {
  if (steps.length === 0) {
    throw new Error("agentTest must call agent.goto() or agent.goal() at least once.");
  }

  return steps
    .map((step, index) => {
      if (step.type === "goto") return `${index + 1}. Open ${step.url}.`;
      return `${index + 1}. ${step.goal.trim()}`;
    })
    .join("\n");
}
