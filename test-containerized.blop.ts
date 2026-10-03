import { agentTest, describe } from "../src/index.js";

describe("containerized browser test", () => {
  agentTest("opens example.com", async ({ agent }) => {
    await agent.goto("https://example.com");
    await agent.goal("Verify the page title contains 'Example Domain'");
  });
});
