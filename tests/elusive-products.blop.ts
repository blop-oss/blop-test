import { agentTest, describe } from "@blop/cli";

describe("elusive.dk", () => {
  agentTest("navigates to products page", async ({ agent }) => {
    await agent.goto("https://elusive.dk");
    await agent.goal(`
      From the homepage, find and click the "Products" navigation link or button.
      Verify that the products page loaded successfully — look for product listings,
      a heading that says "Products", or similar evidence.
      Capture screenshot of home page and product page as proof.
      Finish as passed if the products page is visible. If the link is missing or
      the page doesn't load, finish as failed.
    `);
  });
});
