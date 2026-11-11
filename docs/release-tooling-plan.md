# Shared release tooling — implementation handoff

Status: agreed direction and implementation contract. The commands below are proposed,
not available yet. This document authorizes no publication. Another agent will implement
and validate the tooling; the current release scripts remain unchanged by this plan.

## Outcome and user decisions

Replace the per-repository manual release runbooks with one tested release engine owned
by Toolbelt. Plugin developers obtain it through their pinned `@toolbelt/sdk` dependency.
All four repositories use the same release rules and publication machinery.

- Commands are non-interactive. Products have different commands; target version and
  stable/prerelease channel are mandatory flags. Missing or invalid arguments fail with
  usage/examples before mutations. Do not prompt for product, bump type, version or approval.
- A local preparation command creates a release PR. It does not create a release tag,
  upload public assets or publish a GitHub release.
- **Merging an explicitly marked, validated release PR is the publication authorization.**
  CI builds the exact merged source, verifies the release and publishes it. There is no
  additional Publish approval. Ordinary feature merges never publish.
- Retry is explicit and non-interactive. It continues an already authorized release;
  it cannot change its product, version, source, channel or approved artifact bytes.
- No Lavish review surface. Keep the implementation and maintained documentation in the
  repositories, with short operator instructions instead of copied shell procedures.

## Public command contract

Run these from the owning repository. Versions below are examples, not versions to reuse.
Every preparation command requires both `--version` and `--channel`.

| Repository/product | Prepare a release PR |
| --- | --- |
| Toolbelt app and bundled tester | `bun run release:app --version 0.2.0 --channel stable` |
| Public SDK, in Toolbelt repo | `bun run release:sdk --version 0.3.0 --channel stable` |
| Processes, Upkeep or SDK Explorer, in that plugin repo | `bun run release:plugin --version 1.3.0 --channel stable` |
| Plugin prerelease example | `bun run release:plugin --version 1.3.0-rc.1 --channel prerelease` |

The exact version makes patch/minor/major intent unambiguous: from `1.2.3`, use `1.2.4`,
`1.3.0` or `2.0.0`, respectively. Do not infer a bump or ask the operator to select one.
Stable channel rejects prerelease versions. Prerelease channel requires a prerelease version.
An already released plugin version cannot be repackaged under another tag or channel.

Append `--check` to the same command to validate/build the proposed version in temporary
staging without modifying tracked files or writing to GitHub. It may read remote state,
download dependencies and create local test/build outputs. It must not create a PR/tag/release.

Retry commands use the product-specific entry point and a mandatory existing tag:

```sh
bun run release:app:retry --tag v0.2.0
bun run release:sdk:retry --tag sdk-v0.3.0
bun run release:plugin:retry --tag v1.3.0
```

A retry locates the persisted release record, verifies authorization/source/artifacts, and
starts or resumes CI. It does not rebuild missing bytes as a substitute for the approved
candidate. If safe recovery is impossible, stop with an actionable error and require a
new release version. If already published correctly, report success without modifying it.

There is no interactive bare `bun run release`. Remove its current immediate-publication
behavior when adopting this system; a retained alias must fail with explicit command help.
Do not leave a second independent publisher reachable through the old host script.

## Ownership, distribution and configuration

The release engine and CLI live in the Toolbelt repository. Publish the CLI in a separate
development-tool entry point/bin of `@toolbelt/sdk`, for example `toolbelt-release` and
`@toolbelt/sdk/release`. Do not import release tooling from the SDK's runtime entry point
or bundle it into plugin runtime output. Extend SDK artifact packaging and test the actual
installed SDK archive, including executable entry points and all internal dependencies.

Plugins obtain the SDK through the pinned GitHub archive URL in `package.json` and
`bun.lock`; `bun install --frozen-lockfile` obtains the same library/tooling version in CI.
No sibling checkout, copied SDK/release source, unpinned script fetch or new repository is
needed. Updating release tooling means updating the SDK dependency deliberately.

Each repository has a small typed `release.config.ts` plus package-script wrappers. The
configuration selects its product/build adapter, staged output and extra artifacts. Read
plugin identity, version, capabilities and targets from the existing manifest; do not
repeat those values in the release config. Read repository identity and reject mismatches.

The engine owns archive creation, descriptors, hashes, version synchronization, generic
verification, Git/GitHub state and publication. Reuse/refactor the host's actual package
schema, bounded archive validator and protocol/lifecycle verification into shared modules;
do not maintain a second approximation of the package contract in the CLI.

Repository-owned adapters retain specialized work:

- Processes builds the process engine, TUI, assets and bundled/standalone terminal artifacts.
- Upkeep builds its plugin and migration entries. Its providers and update behavior remain
  plugin-owned; the release engine does not understand their business logic.
- SDK Explorer builds its scenarios, migration, assets and harmless payload.
- Toolbelt builds/signs/packages the app and tester; its SDK adapter packages the SDK.

Preserve existing runtime features, command names, legal notices and target support. Replace
duplicated packaging/publication logic, not plugin behavior or specialized native builders.

## Version and release preparation

The preparation command checks arguments, repository, supported machine/runtime, installed
SDK/tooling, credentials, clean source, source branch/base, version uniqueness and publication
prerequisites. Failures explain the specific action needed; none should require reading Bash.

Create a release branch and PR against main using the caller's authenticated GitHub access.
Update these product-specific version sources automatically, plus the corresponding changelog:

| Product | Version sources and release identity |
| --- | --- |
| Plugin | Root `package.json` and `toolbelt.json`; tag `v<plugin-version>` |
| App/tester | Root `package.json`; app and tester share this version; tag `v<app-version>` |
| SDK | `SDK_VERSION` via an explicit tested adapter; tag `sdk-v<sdk-version>` |

Keep a dedicated SDK changelog under `packages/sdk/` so SDK release notes are not confused
with app notes. Keep `SDK_VERSION` as the initial authoritative SDK version; do not invent
an unrelated bump in the root app version. Support its update with a validated adapter,
not a broad source-text replacement. Generated SDK package metadata derives from that value.
Ordinary behavior changes continue to contribute changelog entries before release preparation.
Move the appropriate Unreleased entries to the requested version/date; require meaningful
notes. Include lockfile changes only when needed and ensure frozen installation succeeds.

The release PR must carry explicit, machine-validated product/version/channel metadata and
show the source, intended files and publication effect. CI must distinguish it from an
ordinary PR using more than an arbitrary title. Validate the metadata against the merged
files and configured repository, reject stale/conflicting requests, and support the repo's
squash-merge policy. The publication source is the actual merge commit, not the PR head SHA.

The operator reviews and merges this PR. The local command never merges it automatically.
A repeated identical preparation request should find/report its existing PR, not open duplicates.

## CI publication pipeline

A small workflow invokes the pinned shared CLI. The engine holds the logic; do not copy
large shell pipelines into each workflow. Generate/validate the thin workflow during adoption.
Keep current action policy: full SHA pins, GitHub-owned actions and approved Bun setup;
no new custom action or cross-repository workflow exception is required.

1. Recognize only an authorized merged release PR on the expected main branch. Check product,
   version/channel, source and uniqueness. Serialize concurrent attempts for that release.
2. Install frozen dependencies, run appropriate tests and build from that exact merged source.
   Build each publication candidate once per target, then freeze it. PR CI can build earlier
   source for validation; its outputs are not the final publication candidate.
3. Validate output using the real package/host contracts. Extract plugin archives into a
   clean environment and run real child-process handshake/readiness/screen/quick-view/probe
   smoke tests. Validate assets, dependencies, migrations and extra artifact formats. Run
   required native target checks on suitable runners; do not claim one CPU proves all targets.
4. Produce a machine-readable release record binding product, repository, source commit,
   version, channel, tooling version and all filenames/sizes/hashes. Persist it with the frozen
   artifacts for subsequent jobs/retries; it is release metadata, not a committed progress doc.
5. Create/check the annotated tag and an unpublished GitHub draft. An existing matching tag
   or draft can be resumed; a different source/version/hash is a conflict, never overwritten.
6. Upload the frozen files. Download the draft assets and compare exact bytes, identities,
   sizes, hashes and required file inventory before publication. Keep plugin descriptors
   compatible with the current host format.
7. Publish only when every required gate passes. Stable app releases advance the app feed;
   SDK releases and all prereleases never do. Stable plugin releases become their repository's
   latest stable plugin release. Verify the final remote state and report its URL/result.

Use read permissions for validation and restrict Contents write to publication jobs.
Do not pass GitHub credentials to plugin smoke-test processes. Do not execute unmerged PR
code in a privileged publisher or allow a fork PR event to bypass the merge gate.
Release-command help must state what it writes and which operation authorizes publication.

## Product artifacts and cross-repository prerequisites

All products use the same engine but retain independent versions:

- **App release:** app DMG plus standalone tester DMG/tarball. The tester is separately
  installable but shares the app's version/release. A separate tester-only publisher is
  outside the initial scope; do not add another version/workflow without a real need.
- **SDK release:** one canonical versioned SDK archive under `sdk-v<version>`. Stop rebuilding
  and attaching a newly generated copy to every app release. App notes/docs can link to the
  canonical SDK asset. SDK publication does not update plugins or publish the app.
- **Plugin release:** ready-to-run archive(s), the existing release descriptor/checksums,
  and configured extras such as the Processes terminal distributions.

A plugin using a newly published SDK must update its exact dependency URL/lockfile through
its own PR. A new SDK API requiring host functionality still needs a compatible host;
matching SDK/app version numbers are not a compatibility test. Release checks validate
requirements and actual package behavior against the appropriate host/tester support.

Toolbelt's bundled Explorer is a pinned, prebuilt plugin archive. Publish that archive before
an app build references it. Add a small non-interactive seed helper with explicit identity:

```sh
bun run seed:update --tag v1.3.0
```

It resolves the SDK Explorer release, verifies its descriptor/archive and prepares a host PR
updating the URL/hash. It must not publish the app, change other plugin repos or bypass seed
removal/disable persistence. Publishing a normal Processes/Upkeep update needs no app release.

Fix the app updater to select the exact intended app DMG by identity/version rather than
the first `*-arm64.dmg` asset. Do not turn upload-order dependence into an automated workaround.
Preserve existing signed-bundle verification and installed-plugin compatibility/busy checks.

## Failure and retry contract

The engine must recover from interruption after any external operation, including a lost
response after GitHub already accepted a request. Inspect remote state before repeating it.
Use persisted artifacts/records; never overwrite published bytes, move a published tag or
silently mix a fresh build with an earlier approved hash. If publication already succeeded,
return the existing verified result. If the record/artifacts are unavailable and cannot be
recovered exactly, stop rather than guessing.

The retry commands operate on the original release identity and rerun only the unfinished
safe stages in CI. They require an already authorized release; they are not an alternate
way to publish an unreviewed version. Provide concise status and error messages, including
the failed stage, whether anything is public and the exact command/action needed next.

## Verification required before adoption

The existing manual guides received shell-syntax, link and selected helper checks, not a
complete GitHub publisher end-to-end test. Existing application/plugin test counts do not
prove release automation. Do not reuse those claims as evidence for the new engine.

Implement and run:

- Pure tests for product/version/channel rules, metadata synchronization, manifests, targets,
  artifact identity, hashes, source bindings and forbidden Latest transitions.
- Integration tests with temporary Git repositories/remotes, real built fixture archives and
  a fake GitHub HTTP service. Interrupt every stage; test partial uploads, lost responses,
  credential failures, stale/changed assets, conflicting tags and simultaneous release jobs.
- Tests proving missing arguments never prompt or mutate, preparation creates only the intended
  version/changelog PR, normal merges never publish, and merged release metadata is revalidated.
- Tests proving retry never rebuilds approved artifacts or mutates a published release.
- Actual SDK-archive installation tests: the CLI and runtime imports work without the Toolbelt
  checkout, and release-tool dependencies/code do not enter plugin runtime bundles.
- Real end-to-end publication and installation in an explicitly authorized disposable GitHub
  repository. Test draft download verification, public publication, post-publication checks
  and retry against actual GitHub behavior. Never use the production app feed for this test.
- Adoption checks using the real builders for SDK Explorer, Upkeep, Processes and Toolbelt,
  including terminal distributions, app/tester DMGs, native targets and isolated profiles.

Automated package/lifecycle smoke checks belong on routine releases. Full manual visual tours
are proportional to UI changes, not a permanent repeated operator requirement for every release.
Tests must use scratch resources, temporary homes and owned processes; no real software updates,
user process control, installed daily-app replacement or real dotfile edits.

## Implementation order and completion

1. Implement the shared engine, typed config/adapters and failure tests in Toolbelt.
2. Publish/bootstrap its SDK tooling through an explicitly authorized procedure, then pilot
   the consumer workflow on the harmless SDK Explorer and a disposable GitHub repository.
3. Adopt Upkeep and Processes. Remove duplicate packagers and version-specific verifier paths;
   keep their business builders/tests and specialized artifact checks.
4. Adopt Toolbelt's app/SDK adapters, CI merge gate, canonical SDK distribution, seed helper
   and exact updater asset selection. Remove the independent immediate-publish host pipeline.
5. Exercise all four repos, failure/retry cases and required target runners. Obtain independent
   review and green CI. Report exactly what was and was not tested.
6. Replace the long per-repo operator runbooks with short explicit command examples and a link
   to shared help/reference. Update agent instructions, SDK acquisition/upgrade documentation
   and release behavior descriptions together. Remove this temporary plan when implementation
   is complete and the current-system documentation accurately covers it.

No repository should need manual checksum Bash, editing a verifier to match each version,
manual draft uploading or knowledge of API retry internals to perform a normal release.
Do not claim completion until the real publisher path is tested and the documented commands
actually exist. Do not publish stable releases or merge main on the user's behalf without
separate implementation/release authorization.

## Current source locations to inspect

- Host publisher and outputs: `scripts/release.ts`, `make-dmg.ts`, `build-tester.ts`,
  `tester-artifacts.ts`, `build-sdk.ts` and `prepare-seed.ts`.
- Shared package/protocol/lifecycle validation: `src/shared/`, `src/sdk/`,
  `src/bun/packages.ts`, `host.ts`, `plugin-manager-service.ts` and `updater.ts`.
- Plugin builders and verifiers: each plugin repo's `scripts/`, `package.json`,
  `toolbelt.json`, `bun.lock` and `.github/workflows/`.
- Current operator/reference docs: [architecture.md](architecture.md),
  [plugins.md](plugins.md), [releases.md](releases.md) and
  [plugin-tester.md](plugin-tester.md). These describe the existing implementation until
  the new tooling is implemented; do not silently advertise proposed commands there early.

Use the repository AGENTS instructions, Bun, direct review/validation and normal feature
PRs. Never use the no-mistakes tool/plugin/skill/pipeline. Do not copy plugin source into
the host or create extra repos for this release tooling.
