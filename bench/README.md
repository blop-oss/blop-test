# Khadim agent latency — measuring stick

Quantifies the streaming work: replacing the blocking per-action PNG/JPEG
screenshot with a live CDP screencast so the host always has the latest view and
actions stay off the screenshot critical path.

The end-to-end wall-clock of an agent run is dominated by **LLM latency** (with
the configured free model, 7–36s per step), which this change does not touch.
So the honest sticks below isolate exactly what changed — the browser/streaming
path — with no model calls.

Run these commands from `packages/test` after installing dependencies with
`pnpm install` at the repository root. Browser/runner assets live in this package;
`run.sh` invokes the CLI entry point in `packages/blop`.

## 1. Per-action screenshot overhead (`micro.ts`)

No LLM. Compares the cost each browser action pays for its visual.

```bash
bun run bench/micro.ts
```

Measured (chromium, headless, example.com, 1280×800):

| Approach | Cost per action |
|----------|-----------------|
| Before — blocking `page.screenshot({jpeg,q45})` | **~38 ms** |
| After — write in-memory screencast frame | **~0.1 ms** |

~38 ms removed from every action's critical path (far more on heavy pages, where
a synchronous screenshot can block for hundreds of ms).

## 2. Live-view throughput through the real runner (`stream-e2e.ts`)

No LLM — drives the **real `runBlopTests` runner** with a mock agent stream
against a locally-served animated page, then reads the same progress NDJSON the
web app (`web-sk`) consumes.

```bash
bun run bench/stream-e2e.ts
```

Measured:

- 5 actions, **all step screenshots served from frames** (~0.1 ms each)
- **~8.5 live frames/sec** pushed to the host (≈150 raw frames captured
  internally over ~2.9s, throttled to one progress line per 100 ms)

Before, the host only received **one image per action** — five total — each
gated behind a blocking screenshot, with the view frozen for the seconds the LLM
spends thinking between actions. After, the host gets a continuous stream and
the per-action capture is effectively free.

## 3. End-to-end smoke (`run.sh`, uses the LLM)

```bash
bash bench/run.sh mylabel              # runs bench/single.blop.ts
```

Sources `OPENROUTER_API_KEY` + `CHAT_AGENT_*` from the repo `.env`, runs the CLI
with `--capture-screenshots --progress-file`, and prints wall time + action
count. Use to confirm the run still passes and frames stream; wall-clock is
LLM-bound and noisy, so prefer sticks 1–2 for the streaming improvement.
