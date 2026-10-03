import type { BlopCiMetadata } from "../runtime/types.js";

const EMPTY: BlopCiMetadata = {
  provider: null,
  runId: null,
  jobId: null,
  branch: null,
  commitSha: null,
  pullRequest: null,
  repositoryUrl: null,
  workflowName: null,
  runAttempt: null,
  runUrl: null,
  refType: null,
  pullRequestNumber: null,
};

export function getCiMetadata(env: NodeJS.ProcessEnv = process.env): BlopCiMetadata {
  if (env.GITHUB_ACTIONS !== "true") return { ...EMPTY };

  const serverUrl = env.GITHUB_SERVER_URL?.replace(/\/+$/, "") ?? null;
  const repository = env.GITHUB_REPOSITORY ?? null;
  const runId = env.GITHUB_RUN_ID ?? null;
  const repositoryUrl = serverUrl && repository ? `${serverUrl}/${repository}` : null;

  return {
    provider: "github-actions",
    runId,
    jobId: env.GITHUB_JOB ?? null,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
    commitSha: env.GITHUB_SHA ?? null,
    pullRequest: env.GITHUB_REF?.startsWith("refs/pull/") ? env.GITHUB_REF : null,
    repositoryUrl,
    workflowName: env.GITHUB_WORKFLOW ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    runUrl: repositoryUrl && runId ? `${repositoryUrl}/actions/runs/${runId}` : null,
    // On a pull_request event GITHUB_REF_TYPE is unset, but the head ref is
    // always a branch; otherwise trust what the runner reports.
    refType: normalizeRefType(env.GITHUB_REF_TYPE) ?? (env.GITHUB_HEAD_REF ? "branch" : null),
    pullRequestNumber: parsePullRequestNumber(env.GITHUB_REF),
  };
}

function normalizeRefType(value: string | undefined): "branch" | "tag" | null {
  return value === "branch" || value === "tag" ? value : null;
}

/** `refs/pull/123/merge` carries the PR number that `vcs.change.id` wants. */
function parsePullRequestNumber(ref: string | undefined): string | null {
  const match = ref?.match(/^refs\/pull\/(\d+)\//);
  return match ? match[1]! : null;
}
