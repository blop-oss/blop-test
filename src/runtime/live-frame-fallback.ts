import { copyFile, rename, rm } from "node:fs/promises";

export type LiveFrameProgress = {
  type: "frame";
  test: string;
  path: string;
  seq: number;
  timestamp: string;
};

export function createStepFramePublisher(options: {
  liveFramePath: string;
  testName: string;
  onFrame: (frame: LiveFrameProgress) => void;
}) {
  let nextSeq = 0;
  let pending = Promise.resolve();

  return {
    publish(screenshotPath: string, timestamp: string) {
      const seq = ++nextSeq;
      const temporaryPath = `${options.liveFramePath}.${seq}.tmp`;
      pending = pending.then(async () => {
        try {
          await copyFile(screenshotPath, temporaryPath);
          await rename(temporaryPath, options.liveFramePath);
          options.onFrame({
            type: "frame",
            test: options.testName,
            path: options.liveFramePath,
            seq,
            timestamp,
          });
        } catch {
          await rm(temporaryPath, { force: true }).catch(() => {});
        }
      });
    },
    flush() {
      return pending;
    },
  };
}
