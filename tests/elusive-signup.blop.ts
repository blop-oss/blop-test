import { agentTest, describe } from "@blopai/test";

// Reproduces the reported "account creation doesn't work" flow on elusive.dk.
// The /login page has a "Create account" mode whose form requires Name + Email
// + Password; missing the required Name makes the browser silently block the
// submit (no navigation, no error), which previously looked like a broken/cookie
// issue. A successful signup redirects to /account and sets the better-auth
// session cookies.
const unique = `blop.qa+${Date.now()}@gmail.com`;

describe("elusive.dk account", () => {
  agentTest("can create a new account", async ({ agent }) => {
    await agent.goto("https://elusive.dk/login");
    await agent.goal(`
      Create a brand-new account on this site.

      Steps:
      - On the /login screen, switch to the "Create account" mode.
      - Fill EVERY field the create-account form requires. It needs a Name, an
        Email, and a Password — do not submit with any required field empty.
        Use name "Blop QA", email "${unique}", and password "BlopTest!2026xZ".
      - Submit the form with the "Create account" button.

      Verify success: after submitting you should be signed in — the page should
      land on the account/archive area and show the account is logged in (for
      example a "Sign out" control and the account name/email). Record that as a
      critical point with the visible evidence, then finish as passed.

      If the form refuses to submit, read the tool feedback for which field is
      missing, fill it, and submit again. Only finish as failed if account
      creation genuinely cannot complete after filling all required fields.
    `);
  });
});
