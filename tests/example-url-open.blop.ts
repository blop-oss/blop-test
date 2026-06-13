import { agentTest, defineAgentTest, describe } from "@blopai/cli";

// Example 1: Using the describe/agentTest DSL — the agent will
// call browser_goto to open the URL, then carry out the goal.
describe("playwright agent", () => {
  agentTest("opens a URL and verifies the page loaded", async ({ agent }) => {
    await agent.goto("https://example.com");
    await agent.goal(
      "Verify the page loaded successfully. Confirm the heading 'Example Domain' " +
        "is visible. Finish the test as passed if the page is usable."
    );
  });

  agentTest("opens a URL and takes a screenshot", async ({ agent }) => {
    await agent.goto("https://example.com");
    await agent.goal(
      "Navigate to the page, take a screenshot, and confirm the page " +
        "contains the text 'illustrative examples'. Finish as passed."
    );
  });
});

// Example 2: Using defineAgentTest — a single object-form test with a
// specific goal. Works the same way but is defined as a plain object.
export default defineAgentTest({
  name: "playwright agent > opens example.com via object form",
  goal: "Go to https://example.com and verify the heading 'Example Domain' is visible. Pass if the page loaded correctly.",
});

// Example 3: Multiple object-form tests exported as an array.
export const moreTests = [
  defineAgentTest({
    name: "playwright agent > checks page title",
    goal: "Go to https://example.com, get the page title, and verify it contains 'Example Domain'. Pass if the title matches.",
  }),
];
