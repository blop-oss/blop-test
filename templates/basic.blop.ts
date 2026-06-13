import { agentTest, describe } from "@blopai/cli";

describe("homepage", () => {
  agentTest("loads and exposes a primary action", async ({ agent }) => {
    await agent.goto("/");
    await agent.goal(`
      Confirm the homepage loads and identify one primary action a user can take.
      Finish the test as passed only if the page is usable.
    `);
  });
});
