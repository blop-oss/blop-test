# Security policy

`@blopai/test` executes authored code and controls real browser sessions through
its harness dependency. Provider credentials, CDP endpoints, page observations,
reports, screenshots, authenticated browser state, and coverage source are
sensitive. See [PRIVACY.md](PRIVACY.md) for normal data flows and retention limits.

## Release status

The standalone package is 0.1.0 and has not yet been published to npm at setup
time. These files do not promise a supported-version schedule, response-time SLA,
or security support for unreleased commits. Include the exact package version or
source commit when reporting; do not treat the default branch as a released
support channel.

## Private vulnerability reports

Do not put vulnerability details, secrets, private URLs, or authenticated state
in public issues, pull requests, commits, or support questions.

Repository administrators must enable GitHub private vulnerability reporting for
`blop-oss/blop-test` before the
[private reporting form](https://github.com/blop-oss/blop-test/security/advisories/new)
can be used. This repository setup does not assert that the form is enabled.
When available, sign in to GitHub and start a private report with a `[Security]`
title. Include:

- Package version or commit, OS, Node/Bun version, and browser/session mode.
- A minimal reproduction with synthetic, non-sensitive data.
- The affected API, configuration, or reporter/provider/upload boundary.
- Expected versus actual boundary, realistic impact, and known mitigations.

Remove keys, tokens, cookies, CDP secrets, private paths, personal data, and raw
reports. There is no separate verified security email provided by this setup.
If the private form is unavailable, do not fall back to a public vulnerability
report. Keep details private until repository administrators enable the channel;
GitHub Support can help with a malfunctioning form without receiving the
vulnerability details through a public project channel.

Repository administrators should assign an owner in the private advisory for
triage, confidential reproduction, remediation, release coordination, and any
handoff. This is a repository operating responsibility, not a claim that an inbox
has been provisioned or a response guarantee.

## Security boundaries

- Authored specs execute code in the host process. Only load reviewed specs and
  dependencies. A browser Docker session does not sandbox the host agent/spec.
- Controlled browser tools are bounded capabilities, not a complete sandbox or
  authorization system. The library cannot prove that an interaction is
  authorized or infer every purchase/account-change consequence.
- Treat page content, observations, URLs, logs, images, and model output as
  untrusted. Prompt injection is possible; do not elevate page text into trusted
  instructions or add arbitrary script/shell escapes.
- CDP endpoints grant broad browser control. Keep them private and authenticated,
  use dedicated profiles, and never expose unauthenticated browser endpoints.
- Browser container isolation depends on network, volume, daemon, and host
  settings. Optional browser/image downloads have third-party supply-chain risk.
- Model providers and collectors may receive application data. Audit endpoints,
  credentials, inherited `OTEL_*` settings, upload options, and artifact retention.
- Live checks require permission, least privilege, bounded execution/spending,
  synthetic accounts, reversible actions, and cleanup. Do not automate a live
  signup, purchase, destructive flow, or bypass of site controls without approval.

For non-sensitive setup problems use the support issue template; ordinary bugs
use the bug template. Browser-tool/session vulnerabilities belong to
[Blop Browser's security process](https://github.com/blop-oss/blop-browser/blob/master/SECURITY.md)
when the affected component is that dependency. Do not copy private report
contents into another project's public tracker.
