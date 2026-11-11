# Releases

Use Bun 1.4.4, Git and authenticated GitHub CLI from the repository root. Preparation needs
push/PR access; retry also needs Actions dispatch access. Use a clean, up-to-date main checkout.
Commands are non-interactive: both the exact version and channel are required. Stable rejects
prerelease versions; prerelease requires a suffix such as `-rc.1`. Versions must increase.

## Prepare and authorize

```sh
bun run release:app --version 0.2.0 --channel stable
bun run release:sdk --version 0.3.0 --channel stable
bun run release:app --version 0.2.0-rc.1 --channel prerelease --check
```

App/tester share root package.json and v<version>. SDK_VERSION in src/shared/package.ts owns
the independent SDK version and sdk-v<version>; its notes live in packages/sdk/CHANGELOG.md.

Preparation updates the product's version sources and dated changelog, commits a machine-readable
`.toolbelt-release.json` request on a release branch, and opens a PR against main. It reports an
existing identical request instead of opening duplicates. Behavior changes belong in Unreleased
before preparation. Review the generated version, notes, compatibility and publication channel.
The command never merges the PR or publishes locally.

**Merging a validated release PR authorizes CI publication without a second approval.** Ordinary
feature merges do not publish. The publisher checks the actual squash/merge commit and its associated
merged same-repository PR; carrying an old request through a later feature merge cannot publish it.
PR CI validates changed release requests against the product version and changelog.

Append `--check` to a preparation command to install, test and build the proposed version in a
temporary source snapshot. It reads GitHub state but does not modify tracked files or write to
GitHub. Native builds require macOS Apple silicon and Xcode command-line tools. Do not stop another
session's app to obtain a build lock; the check command builds in its own staging directory.

## Product-specific validation

Release-only PRs remain mandatory. A Toolbelt SDK release-only diff must change exactly
`.toolbelt-release.json`, `packages/sdk/CHANGELOG.md` and the `SDK_VERSION` constant in
`src/shared/package.ts`. Its CI runs `bun run sdk:check` and `bun run sdk:package`, plus
the normal secret/workflow checks and required CI gate. SDK checks include standalone
typechecking, runtime/fake-host and protocol tests, package/integrity/recovery checks used
by the bundled release CLI, and installation/execution of the SDK archive. It does not
bootstrap Electrobun or build the app, seed, tester or disk images.

Other diffs, missing scope evidence and manual CI runs use full app and SDK validation.
Shared runtime, schema, renderer, dependency or workflow changes never qualify as an
SDK release-only diff. The final merged SDK candidate uses the same SDK validation
through its product adapter. Other products keep the default full typecheck/test checks.
Adapters can supply `validate()` to define complete product-specific checks; omitting
it preserves existing behavior. Separate version PRs, merge authorization and frozen
publication verification remain required.

## Build and publish

The Release workflow installs frozen dependencies and builds the exact authorized merged source.
It runs tests, validates archives with the host's bounded extractor/schema and real child-process
readiness, screens, quick view and probe preparation. Plugin smoke processes receive temporary
homes/data and no GitHub credentials. Native package execution runs on each declared target's
runner before publication; platform-specific business tests remain in the product repository.

The candidate is built once and saved with `release-record.json`: source, repository, product,
version, channel, tooling version, filenames, sizes, hashes and notes. CI retains the candidate
artifact for 90 days. Publication has a separate job with Contents write; build/native jobs have
read permissions. The publisher creates an annotated tag and draft, uploads exact frozen bytes,
downloads and compares every file and checks inventory before publishing. The release record is
also a release asset. Existing differing tags or bytes are conflicts, never overwritten.

Stable app releases advance ToolBelt Latest. SDK releases and all prereleases use Latest=false.
Stable plugin releases advance Latest only in their own repository. Published assets and tags are
immutable. Corrections require a new version. App notes retain the `## Downloads` boundary used
by the updater. App DMGs are ad-hoc signed and verified, not Apple-notarized.

## Retry

```sh
bun run release:app:retry --tag v0.2.0
bun run release:sdk:retry --tag sdk-v0.3.0
```

Retry dispatches CI for an already merged release request. It cannot change product, source,
version, channel or frozen bytes. A failed build can run again before a candidate is saved.
After a candidate is saved, retries reuse the original CI artifact. A draft/public release with
missing retained candidate files stops for exact-byte recovery; it never substitutes a rebuild.
If publication succeeded but its response was lost, retry verifies and reports the existing
immutable release. Inspect the failed workflow stage before retrying. Do not delete tags, clobber
assets or rerun an old manual publisher. If exact recovery is unavailable, prepare a new version.

Local build/package commands create files only. Bare `bun run release` does not publish.
Never replace the installed daily app or operate real software/processes/dotfiles to test a release.

## Products and distribution

- App: Toolbelt-<version>-arm64.dmg and Plugin Tester DMG/tarball, sharing the app version.
- SDK: one canonical toolbelt-sdk-<version>.tgz under sdk-v<version>. App releases link to
  the SDK rather than rebuild it. The archive includes the runtime SDK and a separate development
  CLI/bin. Release tooling is never imported by the runtime entry point.
- Plugins: ready-to-run archives, checksum sidecars, toolbelt-release.json and configured extras.

The engine lives in src/release/. release.config.ts supplies version/changelog/build adapters.
Plugins consume its public @toolbelt/sdk/release entry and toolbelt-release bin through their
exact SDK URL and frozen lockfile. Updating tooling requires deliberately updating that SDK pin.
The installed SDK archive is tested without a host checkout. Package/protocol/data-schema versions
remain independent of product and SDK versions.

Publish a compatible SDK before plugin dependency PRs consume it. Publish SDK Explorer before
changing the host's seed. Use `bun run seed:update --tag <published-explorer-tag>` from clean main
to verify its descriptor/archive and open a host PR updating seed.config.json. This neither publishes
the app nor changes disable/removal persistence. New SDK APIs requiring host functionality still
need a compatible host/tester; matching version numbers do not establish compatibility.
