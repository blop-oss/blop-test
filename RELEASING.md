# Repository setup and releases

This repository prepares `@blopai/test` 0.1.0 for standalone development and
release. It does not create the GitHub repository, enable npm publishing, or
establish a maintainer login. At setup time the package is not on npm, and no npm
publisher is configured by these files. Publication requires separate authorized
maintainer action; never infer authorization from a working build or tag.

## External repository settings

For the canonical `blop-oss/blop-test` repository, administrators must:

- Use `master` as the default branch, matching `blop-browser`; CI checks pushes to
  `master`, pull requests, and reusable workflow calls.
- Enable GitHub Actions and permit the referenced checkout, Node, Bun, and GitHub
  release actions. Require the `verify` CI job for reviewed changes and protect
  `master` against unreviewed pushes.
- Restrict creation/movement of `test-v*` tags to authorized release owners.
  Release concurrency prevents overlapping runs for a tag, not malicious tags or
  unreviewed code execution.
- Enable GitHub private vulnerability reporting before directing reporters to
  the private form in [SECURITY.md](SECURITY.md). The configuration files do not
  prove that this external setting is enabled.
- Review issue labels and enable the repository's issue tracker. The templates
  do not depend on precreated labels or invented contact addresses.

No response-time promises or external support channels are established here.

## First npm publication

npm trusted-publisher settings are attached to an existing package. The first
publication of a new package needs an authorized npm account with rights to the
`@blopai` scope; a tag alone cannot bootstrap those rights.

Before publishing, the maintainer must verify the source, package contents,
license, version, and dependency availability. Install dependencies with
`bun install --frozen-lockfile`, install Chromium, and run the
complete sequence from [CONTRIBUTING.md](CONTRIBUTING.md). Inspect
`npm pack --dry-run` as well as `bun run check:package`. Authenticate through npm's
approved interactive/account process with the required two-factor authentication
and publish the reviewed package with `npm publish --access public` only when
explicitly authorized. Do not put a bootstrap token in the release workflow.

npm versions are immutable: once 0.1.0 is bootstrapped manually, do not push a
`test-v0.1.0` tag expecting this workflow to republish it. Create any record of the
bootstrap release separately, or release a new version after trusted publishing
is configured. This workflow intentionally has no publish-skipping fallback for
already published versions; a rejected npm publish cannot create a misleading
successful GitHub release.

Publish a required testing-library version before a CLI version that depends on
it. Verify `@blopai/browser-harness` and `@blopai/ingest` are available from npm;
the standalone package has no workspace/file dependency substitution.

## Configure npm trusted publishing

After the initial authorized publication, open the package settings on npmjs.com
and add a GitHub Actions trusted publisher with:

- Organization or user: `blop-oss`.
- Repository: `blop-test`.
- Workflow filename: `release.yml` (the file in `.github/workflows/`).
- Environment: leave empty; this workflow does not name a GitHub environment.

Enable the strongest suitable npm publishing-access/2FA policy only after
confirming account recovery and trusted publishing work. No `NODE_AUTH_TOKEN`
secret is required or used by the workflow. It grants `id-token: write` only to
the release job, which exchanges GitHub's identity through npm 11.5.1. A public
repository/package and correct identity registration are needed for the expected
provenance publication. External policy changes or incorrect registration can
still reject publishing; do not bypass them with token fallbacks.

## Subsequent releases

Update `package.json` and the lockfile together, document public changes, and
land a reviewed change with successful CI. Use Node 22.14.0, Bun 1.3.13, and npm
11.5.1 for the release environment. When explicitly authorized, push a tag named
`test-v` followed by the exact package version. Do not reuse/move a release tag.

[release.yml](https://github.com/blop-oss/blop-test/blob/master/.github/workflows/release.yml) first calls
[ci.yml](https://github.com/blop-oss/blop-test/blob/master/.github/workflows/ci.yml). The publishing job then checks the tag/version
match, performs a frozen installation with the reviewed Git build trusted, cleans and
builds, verifies npm contents/exports, and runs
`npm publish --access public --provenance`. npm's `prepublishOnly` also cleans and
builds. Only a successful publication proceeds to the generated-notes GitHub
release. Generated release notes are not test evidence or a declaration that
live examples passed. Review the resulting package/provenance and release notes.

## Dependency resolutions and tooling choices

Runtime dependencies and public optional peers retain the source resolutions
except for the explicitly reviewed browser-harness compatibility update. Its
immutable public Git revision aligns camoufox-js 0.11.1, Playwright 1.61.1, and
Camoufox 152.0.4-beta.30, rather than selecting a newer incompatible browser.
The SDK preserves nullable container egress as unknown instead of claiming
reachability. Only browser-harness's Git `prepare` is explicitly trusted by
Bun; it builds the dependency's public distribution before SDK compilation.
The lockfile was generated with Bun 1.3.13 and records the exact source revision.
`bun.lock` records every transitive resolution and integrity hash; frozen CI must
not resolve newer versions opportunistically.

Direct locked resolutions are:

- `@blopai/browser-harness` 0.1.10 at the recorded Git revision; `@blopai/ingest` 0.2.0.
- `@opentelemetry/api` 1.9.1; `@opentelemetry/semantic-conventions` 1.43.0.
- `@opentelemetry/core`, `resources`, `sdk-metrics`, and `sdk-trace-node` 2.10.0.
- `@opentelemetry/api-logs`, `sdk-logs`, and the six OTLP HTTP/proto exporters
  (logs, metrics, traces) 0.221.0.
- `playwright` and `playwright-core` 1.61.1; `camoufox-js` 0.11.1; `zod` 3.25.76.
- `@types/node` 22.15.18; TypeScript 5.8.3; Vitest 3.2.6.
- New development-only tools: Prettier 3.9.6 and Oxlint 1.78.0, pinned to the
  reference repository's tool versions. No new runtime dependency was added.

Formatting covers Markdown, workflows, JSON setup, and verification scripts,
not runtime TypeScript. Oxlint applies a focused explicit correctness rule set
(no debugger, duplicate keys/cases, self-assignment, unreachable code, unsafe
finally, or invalid `typeof` comparisons), not style rewrites or browser
claim checkers. TypeScript remains the source typecheck/build gate. The local-link
checker verifies file destinations, including Markdown references and image
sources; it deliberately does not claim remote-URL or heading-anchor validation.
The package checker inspects npm's dry-run list, each export, and compiled outputs;
it does not claim a real consumer execution or publication.

Compatibility risks to include in verification:

- The source workspace linked a local `@blopai/ingest` checkout. Standalone setup
  resolves its published 0.2.0 tarball instead. Confirm the exported classifiers,
  ingest protocol, and types with build/tests and a packed consumer.
- The source lock used a patched browser-harness 0.1.5. Its screenshot readiness
  correction now lives in the reviewed upstream source consumed by all SDK
  installations, rather than in a development-only dependency patch.
- Standalone transitive dependencies are newly resolved within existing ranges,
  not a byte-for-byte workspace graph. In particular Vitest resolves Vite 7.3.6
  and esbuild 0.28.2; the source workspace had Vite 7.3.3. These are recorded here,
  not hidden runtime dependency upgrades. Vite 7 development tooling needs a
  recent Node 22 (22.12+), even though the runtime engine remains `>=22`.
- Frozen CI installation prepares only the explicitly trusted Git dependency
  plus the SDK's own build. Explicit browser and Docker gates must still prove
  actual startup, config-schema compatibility, and screenshot behavior.

Keep resolutions/risks up to date when refreshing the lockfile. Do not remove a
compatibility limitation just because deterministic tests or formatting pass.
