import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStepFramePublisher } from "../../src/runtime/live-frame-fallback";
import { createTempDir } from "../test-utils/files";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("non-CDP live frame fallback", () => {
  test("publishes an action screenshot through the live preview frame contract", async () => {
    const temp = await createTempDir();
    cleanup = temp.cleanup;
    const screenshotPath = join(temp.dir, "step-1.jpg");
    const liveFramePath = join(temp.dir, "live.jpg");
    const jpeg = Buffer.from("camoufox-preview-frame");
    await writeFile(screenshotPath, jpeg);
    const frames: Array<Record<string, unknown>> = [];
    const publisher = createStepFramePublisher({
      liveFramePath,
      testName: "Camoufox preview",
      onFrame: (frame) => frames.push(frame),
    });

    publisher.publish(screenshotPath, "2026-07-25T10:00:00.000Z");
    await publisher.flush();

    expect(await readFile(liveFramePath)).toEqual(jpeg);
    expect(frames).toEqual([{
      type: "frame",
      test: "Camoufox preview",
      path: liveFramePath,
      seq: 1,
      timestamp: "2026-07-25T10:00:00.000Z",
    }]);
  });
});
