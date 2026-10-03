import { defineAgentTest } from "@blopai/test";

// Deterministic single-goal benchmark used as the latency "measuring stick".
export default defineAgentTest({
  name: "bench > open example.com",
  goal:
    "Go to https://example.com and verify the heading 'Example Domain' is visible. " +
    "Then finish the test as passed.",
});
