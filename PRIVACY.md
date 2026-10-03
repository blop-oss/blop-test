# Privacy and data flows

Local reports do not imply a local-only browser-agent run. Review these separate
boundaries before testing private or authenticated applications. This document
explains library behavior, not a provider's retention policy or a guarantee that
third-party services are configured safely.

## Where data goes

- **Application/browser:** browser sessions send ordinary page requests to the
  target and its third-party resources. Navigation can change server state.
  Authenticated contexts can access the account's permissions. Remote CDP gives
  broad browser control; use dedicated profiles and private authenticated
  endpoints. Browser tools come from
  [browser-harness](https://github.com/blop-oss/blop-browser).
- **Model provider:** the native OpenAI-compatible loop sends goals, conversation,
  tool observations/results, and image evidence when supplied to the configured
  provider endpoint. `BLOP_AGENT_PROVIDER`, `BLOP_AGENT_MODEL`,
  `BLOP_AGENT_API_KEY`, and optional `BLOP_AGENT_BASE_URL` select this boundary.
  Provider-native keys need explicit mapping. No hosted Blop account is needed,
  but that does not prevent provider disclosure. Review provider terms, costs,
  retention, and authorized data handling separately.
- **Local evidence:** reports, events, screenshots, progress streams, critical
  points, and coverage may include private URLs, page text, user data, and source.
  The default report directory is `.blop`; a configured report/progress location
  may be elsewhere. Files persist until the user deletes them. Repository ignores
  are not encryption, access controls, or retention enforcement.
- **OpenTelemetry collector:** export is enabled when collector endpoints resolve
  from explicit options or supported `OTEL_*` environment settings. With no
  resolved signal endpoint the reporter does not initialize the OTel SDK.
  Different signals can use different endpoints and auth headers. Exported
  diagnostic evidence and metadata can be sensitive. Audit inherited environment
  variables, not just CLI flags. Browser trace-context propagation is opt-in and
  requires the configured host allowlist; it is not a run/trace storage join.
- **Hosted ingest/artifacts:** `@blopai/test/platform` delegates to the ingest
  client. Without its required configuration, upload returns a skipped result;
  configured upload can send run metadata and a bundle of report-directory files.
  Review the directory contents before enabling it; `skipArtifacts` suppresses
  artifact bundling, not necessarily run metadata. The optional upload API is
  separate from local checks and model calls.
- **Coverage collector:** `coverage: true` writes local JavaScript coverage;
  `coverageEndpoint` additionally posts to `/api/test-coverage` at the explicit
  collector base URL. It never starts a server. Coverage includes retained source
  code and URLs, not just percentages. The CLI's local inspector/collector belongs
  in blop-app and is not shipped by this library.

## Safe operating practices

Use staging/local fixtures, synthetic identities, least-privileged accounts,
isolated browser contexts, and approved endpoints. Set bounded steps/timeouts and
spending before live runs. Inspect reviewed spec imports: specs execute as code,
and Docker isolation of a browser does not sandbox the host spec/model loop.
Do not put secrets in goals or screenshots. Page content is untrusted and can
attempt prompt injection; bounded tools do not replace human authorization.

Before sharing artifacts, review all JSON/JSONL/XML, screenshots, URLs/query
strings, coverage sources, console/network evidence, and bundles. Automated
redaction is not a complete privacy guarantee. Share a minimal sanitized
reproduction instead of a raw report. Never commit `.env`, tokens, cookies,
authenticated storage state, or private application data. Keep failed evidence
long enough to investigate safely, with access and deletion policy appropriate to
the application; do not remove failures only to make a summary look successful.

Authorized live checks may still purchase, submit forms, send messages, or create
accounts. In particular `tests/elusive-signup.blop.ts` is state-changing on a live
site. Explicit approval, synthetic identities, cleanup, and artifact retention
are required. CLI `--base-url` does not override absolute URLs in a spec.

No project-wide provider retention, telemetry consent, hosted deletion SLA, or
anonymity promise is established here. Repository administrators must provision
private vulnerability reporting as described in [SECURITY.md](SECURITY.md).
