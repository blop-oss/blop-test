import type { BlopRunResult } from "../runtime/types.js";

export async function uploadRunToPlatform(options: {
  platformUrl?: string;
  apiKey?: string;
  result: BlopRunResult;
}) {
  if (!options.platformUrl || !options.apiKey) {
    return { uploaded: false, reason: "platform_not_configured" } as const;
  }

  const response = await fetch(new URL("/api/runs/ingest", options.platformUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(options.result),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Blop Platform upload failed: ${response.status} ${body}`.trim());
  }

  return { uploaded: true } as const;
}
