import { agentTest, describe } from "@blopai/test";

describe("elusive.dk", () => {
  agentTest("navigates to products page", async ({ agent }) => {
    await agent.goto("https://blackboxpuzzles.workroomprds.com/puzzle35/");
    await agent.goal(`
      From the homepage, interact with the puzzle and solve it.
      Capture screenshot of the puzzle and the solution as proof.
      Finish as passed if the puzzle is solved. If the puzzle is not solved, finish as failed.
    `);
  });
});
