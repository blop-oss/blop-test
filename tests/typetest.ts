import { agentTest, describe } from "blop";

describe("elusive.dk", () => {
  agentTest("navigates to products page", async ({ agent }) => {
    await agent.goto("https://testautomationpractice.blogspot.com/");
    await agent.goal(`
      From the homepage, go here and do all of the tasks and finish as passed.
      Capture screenshot of the tasks and the solution as proof.
      Finish as passed if the tasks are completed. If the tasks are not completed, finish as failed.
      just fill the form and submit it and finish as passed.
    `);
  });
});
