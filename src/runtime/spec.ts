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
  const mod = await import(pathToFileURL(specFile).href);
  const exported = mod.default ?? mod.tests;

  if (exported) {
    const tests = Array.isArray(exported) ? exported : [exported];
    return tests.map((test) => agentTestSchema.parse(test));
  }

  const tests = registeredTests.slice(startIndex);
  return Promise.all(tests.map(materializeRegisteredTest));
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
