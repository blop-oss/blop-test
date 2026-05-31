import { agentTest, defineAgentTest, describe } from "blop";

// Example 1: Using the describe/agentTest DSL — the agent will
// call browser_goto to open the URL, then carry out the goal.
describe("playwright agent", () => {
  agentTest("Goes to youtube and finds a video of a cat", async ({ agent }) => {
    await agent.goto("https://youtube.com");
    await agent.goal(
      "Go to youtube and search for cat videos and play a cat video and describe what the cat does  " +
        "When youve got a good understaning of the video finish the test"
    );
  });
});
