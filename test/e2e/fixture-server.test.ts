import { afterEach, describe, expect, test } from "bun:test";
import { startFixtureServer } from "../test-utils/server";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("fixture server", () => {
  test("serves isolated app pages for agent/browser e2e tests", async () => {
    const server = await startFixtureServer([
      {
        path: "/",
        body: `<main><h1>Agent checkout fixture</h1><button>Start checkout</button></main>`,
      },
    ]);
    closeServer = server.close;

    const response = await fetch(server.url);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Agent checkout fixture");
    expect(html).toContain("Start checkout");
  });

  test("returns 404 for missing fixture routes", async () => {
    const server = await startFixtureServer([]);
    closeServer = server.close;

    const response = await fetch(`${server.url}/missing`);

    expect(response.status).toBe(404);
  });
});
