import type { BlopCiMetadata } from "../runtime/types.js";

export function getCiMetadata(env: NodeJS.ProcessEnv = process.env): BlopCiMetadata {
  if (env.GITHUB_ACTIONS === "true") {
    return {
      provider: "github-actions",
      runId: env.GITHUB_RUN_ID ?? null,
      jobId: env.GITHUB_JOB ?? null,
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
      commitSha: env.GITHUB_SHA ?? null,
      pullRequest: env.GITHUB_REF?.startsWith("refs/pull/") ? env.GITHUB_REF : null,
    };
  }

  return {
    provider: null,
    runId: null,
    jobId: null,
    branch: null,
    commitSha: null,
    pullRequest: null,
  };
}
