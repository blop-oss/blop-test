# Testing history

The first actual testing implementation was committed to [blop-app](https://github.com/blop-oss/blop-app/commit/5dbf04d675150b95d98cbb474c87ab7142ec5718) on **2026-05-09 at 13:43:30 +02:00**. Both its author and committer timestamps are original, not backdated. The extracted first snapshot is `a6b368ec526856f12dc1521661f3578e1f837ce1`.

The default `master` branch begins with that genuine snapshot. Later testing work and standalone repository setup are squash-imported through a pull request. New setup and the squash merge retain their actual creation dates; GitHub repository creation also remains its real date.

## Full provenance

The retained `provenance/test-history` branch contains **43 extracted commits**, through source commit `87349b327b0ac4fd96aab84787a5ca20942a4927`. [The commit ledger](provenance/commits.json) records original and rewritten IDs, original author/committer identities, and both timestamps. [The path map](provenance/path-map.json) records exactly which files were extracted. SHA values necessarily change when paths and commit parents change. All retained identities and timestamps were compared against the source repository.

The extraction follows files now owned by the testing SDK, including runtime, reporters, upload, configuration, tests, fixtures, benchmarks, templates, and the new package directory. The old public CLI barrel is retained under `historical/` on the archive branch to preserve the original testing export boundary; it is removed from the current standalone tree. Unrelated CLI documentation and commits without retained file changes are excluded. Ancestor snapshots preserve their historical code and context, not a claim that each is independently buildable as a standalone package.

At extraction, **50 runtime, regression, authored-spec, and template files** were byte-compared with the committed package source; their code was unchanged. Repository-only metadata, dependency installation, CI/release workflows, and standalone documentation are adapted separately. npm publication dates are not reconstructed from Git history.
