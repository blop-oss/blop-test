import { defineAgentTest } from "@blopai/cli";

// Mirrors web-sk's no-GitHub site-feedback run (DEFAULT_FEEDBACK_GOAL in
// apps/web-sk/src/lib/server/projects/feedback.ts) against elusive.dk, to
// reproduce small-model runs that explore but never call finish_test.
export default defineAgentTest({
  name: "Site feedback",
  goal:
    "The site under test is https://elusive.dk/. " +
    "Act as a first-time visitor giving UX and functional feedback on this site. " +
    "Start at the homepage and explore the main pages and primary calls to action. " +
    "Evaluate: clarity of the value proposition, navigation, primary actions, page " +
    "load behavior, and any broken links, console errors, or confusing UI. " +
    "Capture concrete, actionable findings as you go. Finish the test as passed once " +
    "you have explored the main pages and summarized your feedback.",
});
