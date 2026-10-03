import { agentTest, describe } from "@blopai/test";

describe("homepage", () => {
  agentTest("loads", async ({ agent }) => {
    await agent.goto("/");
    await agent.goal("Verify the homepage loads and the primary user action is visible.");
  });
});
