# Releasing Toolbelt, the SDK and Plugin Tester

This runbook describes the commands implemented in this repository. Run them from its root
on an Apple silicon Mac. Publishing is a deliberate maintainer operation, not a consequence
of merging a PR, pushing a branch or passing CI. Run one stage at a time and stop on
any nonzero command or failed comparison; a later command succeeding does not repair an
earlier failure. None of the publication blocks below should be run just to check syntax.

## What publishes, and what does not

| Command or event | Local result | GitHub effect |
| --- | --- | --- |
| `bun run build` | App/update bundle in `artifacts/`, app build in `build.noindex/` | None |
| `bun run dmg` | Builds, mounts and verifies the app DMG from the update bundle | None |
| `bun run sdk:package` | SDK `.tgz` in `artifacts/` | None; no npm publication |
| `bun scripts/build-tester.ts` | Native tester, DMG and tarball in `artifacts-tester/` | None |
| `bun run release --dry-run` | Checks, rebuilds all four deliverables and prints release notes | No tag push or release creation/publication |
| `bun run release` | Rebuilds and verifies local deliverables | Pushes an annotated tag, creates a draft, uploads four assets, then publishes it as **Latest** |
| PR/main CI | Validates, tests and builds the app/SDK | No release publication; the workflow has no tag-release job |

**Yes: `bun run release` on the development machine creates and publishes the actual GitHub
release using that machine's `git` and authenticated `gh` CLI.** It does not ask for another
confirmation or pause at the draft. The only supported script option is `--dry-run`.
Do not pass `--prerelease` or `--latest=false` to this script: it does not implement them.
Use the manual draft procedure below for a prerelease or a pre-publication asset review.

The automation is [scripts/release.ts](../scripts/release.ts). CI is
[.github/workflows/ci.yml](../.github/workflows/ci.yml). CI builds/verifies the app DMG and
packages the SDK, but does not build the tester; the release command does build it.

## Products, versions and dependencies

| Product | Version source | Published asset |
| --- | --- | --- |
| Toolbelt app | `package.json` `version` | `Toolbelt-<app-version>-arm64.dmg` |
| SDK | `SDK_VERSION` in `src/shared/package.ts` | `toolbelt-sdk-<sdk-version>.tgz` |
| Plugin Tester | Same root `package.json` version as the app | `Toolbelt-Plugin-Tester-<app-version>-arm64.dmg` and `Toolbelt-Plugin-Tester-<app-version>-macos-arm64.tar.gz` |

An app release is tagged `v<app-version>` and attaches all four assets. It does **not** create
an `sdk-v<version>` release or change any plugin's SDK dependency URL. Dedicated SDK releases
are a separate manual operation described below. There is no npm publish step and no
separate tester version field. Processes terminal archives are released by `toolbelt-ps`,
not by this script. Electrobun intermediate archives/update JSON are build inputs, not the
four public release downloads.

Before a release involving public SDK changes:

1. Complete the SDK/host/renderer changes and tests. Choose a new `SDK_VERSION` when publishing
   changed SDK content; align SDK version statements/examples in its README and author docs
   in the same PR. Do not overwrite a previously published SDK asset.
2. If plugin repos must consume the SDK before the app release, publish its dedicated SDK
   archive first. Updating the SDK pin/lockfile and publishing each plugin are separate steps.
3. Publish and verify any SDK Explorer update in its own repo. Then change the exact demo
   archive URL and SHA-256 in `scripts/prepare-seed.ts` through a host PR. App builds download
   that pinned archive; they cannot build an unpublished sibling checkout.
4. Verify plugin host/Bun/capability requirements against the host/tester being released.
   A plugin needing new host capabilities is not made compatible by an SDK version alone.

Processes and Upkeep releases do not otherwise require an app release. A demo release does
not automatically change the bundled seed; an SDK release does not automatically update
plugin lockfiles. Plugin runbooks: [Processes](https://github.com/tkarakai/toolbelt-ps/blob/main/docs/releases.md),
[Upkeep](https://github.com/tkarakai/toolbelt-upkeep/blob/main/docs/releases.md),
[SDK Explorer](https://github.com/tkarakai/toolbelt-sdk-demo/blob/main/docs/releases.md).

## Prepare a stable release PR

1. Choose an unused app semantic version. In a release branch, change root `package.json`
   `version` and turn the relevant `CHANGELOG.md` Unreleased entries into a nonempty
   `## X.Y.Z — YYYY-MM-DD` section matching that exact version. Leave a new Unreleased
   section for subsequent work. App and tester use this same version.
2. If SDK content changes, also update `SDK_VERSION`; include any required frozen-lockfile
   changes from dependency work. Do not change package format, protocol or data-schema
   versions just to match the app version.
3. Review the demo URL/hash and compatible plugin packages. Run normal checks and an
   isolated app/tester smoke test, including fresh-profile seed and installed-plugin
   compatibility. Use the [maintenance procedures](maintenance.md) for updater rehearsals.
4. Open the release PR. Wait for CI and the maintainer/user to merge it. Merging this PR
   publishes nothing. Do not invoke the stable publication script from a feature branch.

## Machine and account prerequisites

Use macOS arm64, Bun 1.4.4, Git, GitHub CLI `gh`, and Xcode command-line tools. The build uses
`codesign`, `hdiutil`, `tar`, `stat` and `/usr/libexec/PlistBuddy`. Signing is ad hoc; these
scripts do not use an Apple Developer signing identity or perform notarization.

The account must be able to push tags and create/edit/upload releases in `tkarakai/toolbelt`
(Contents write for a restricted token). Git must have a name/email for annotated tags.
Check access before spending time building; do not paste tokens into commands or logs:

```sh
bun --version
uname -m
gh auth status
gh repo view tkarakai/toolbelt
git config user.name
git config user.email
git remote get-url origin
```

Use a dedicated clean main checkout. If another session owns main, use another maintained
checkout rather than changing that session's branch or stopping its app. Close only your own
`bun run dev` instance; dev and app build share a lock. Network access is required for locked
dependencies, the Electrobun devkit and the pinned public demo archive.

```sh
git switch main
git pull --ff-only origin main
git fetch --tags origin
git status --porcelain
bun install --frozen-lockfile
bunx electrobun prepare
```

The status command must print nothing, HEAD must equal `origin/main`, and the chosen tag
must not exist locally or remotely. Read the actual version, rather than assuming a value:

```sh
release_version=$(bun -p '(await Bun.file("package.json").json()).version')
release_tag="v${release_version}"
sdk_version=$(bun -p '(await import("./src/shared/package.ts")).SDK_VERSION')
git rev-parse HEAD
git rev-parse origin/main
git tag --list "$release_tag"
git ls-remote --tags origin "refs/tags/$release_tag"
```

The tag commands must return no match. Stop if the release version/changelog is wrong, the
working tree is dirty, or the tag is already used. Never move/delete a published tag to
make a rerun work.

## Standard stable publication: automated

### 1. Rehearse

```sh
bun run release --dry-run
```

This is a **real build**, not a read-only preview. It downloads build inputs, runs typecheck
and tests, builds the app, creates/mounts/verifies its DMG, packages the SDK, builds/packages
and verifies the tester, and prints the exact four files and notes. It does not publish.
It relaxes branch/dirty/remote-equality checks and does not fetch remote tags; it still
requires arm64, an unused local version tag and a nonempty matching changelog section.
A successful dry run on dirty/feature code is not proof that main is ready to publish.

Test the built app through `bun scripts/run-evaluation.ts`, and open the tester using an
isolated profile. Verify intended plugin support. Recheck clean main after the smoke test.
Do not run another build in parallel: app builds replace `artifacts/`, and tester builds
replace `artifacts-tester/`.

### 2. Publish, only when authorized

```sh
bun run release
```

The command performs these operations in order:

1. Enforces main, clean working tree, fetched `origin/main` equality and absent `v<version>` tag.
2. Extracts the nonempty matching changelog section; checks Apple silicon; runs typecheck/tests.
3. Runs the app build, then creates the real signed app DMG and mounts it to verify bundle
   identity, version and strict signature. Packages the SDK and builds/packages the tester.
4. Creates the annotated local tag at current HEAD and pushes that tag to `origin`.
5. Creates a GitHub **draft** release in `tkarakai/toolbelt`, with `--verify-tag`, the versioned
   title and changelog-based notes followed by `## Downloads` and installation notes.
6. Uploads app DMG **first**, then SDK, tester tarball and tester DMG. Each upload retries up
   to three times using `--clobber` on this still-unpublished draft.
7. Runs `gh release edit ... --draft=false --latest`, immediately publishing the release and
   moving GitHub's Latest pointer. Prints the release URL.

It does not install the app, replace your local daily app, publish any plugin, or update
plugin SDK pins. It verifies local DMGs, but does not download draft assets for comparison
or pause before publication. If that review is required, use the manual draft path instead.
A dry run followed by publication builds twice; the uploaded bytes are from the publishing run.

### 3. Verify the public release

```sh
gh release view "$release_tag" --repo tkarakai/toolbelt \
  --json tagName,isDraft,isPrerelease,url,assets
git rev-parse "$release_tag^{commit}"
gh api repos/tkarakai/toolbelt/releases/latest --jq '.tag_name'
```

Expect the intended tag/commit, `isDraft: false`, `isPrerelease: false`, exactly the four
intended assets, and Latest equal to the new app tag. Download and compare the files using
[asset verification](#download-and-verify-all-four-assets). Check updater selection below.
Launch a copied app/tester from the downloads in isolated profiles and test an actual public
plugin installation. Check the first-launch/installation behavior of a downloaded ad-hoc
signed app; a valid strict signature is not Apple notarization. A published release does not prove all consumers have already updated.

## Manual app/tester release: draft review or prerelease

Use this path instead of `bun run release` when the draft must remain unpublished until
remote byte verification, or for an explicitly approved prerelease. Use clean reviewed
source; stable releases use main. For a prerelease, the committed package version, changelog
section and tag must include the intended prerelease version, for example `0.2.0-rc.1` /
`v0.2.0-rc.1`. These are examples, not versions to reuse.

Perform the same preflight/version/tag checks above. Build **before** creating a tag:

```sh
bun run typecheck
bun test
bun run build
bun run dmg
bun run sdk:package
bun scripts/build-tester.ts
```

Create release notes outside the checkout from the exact matching changelog section:

```sh
release_notes=$(mktemp "${TMPDIR:-/tmp}/toolbelt-release-notes.XXXXXX")
bun - "$release_version" > "$release_notes" <<'NOTES'
const version = process.argv[2];
const lines = (await Bun.file("CHANGELOG.md").text()).split("\n");
const start = lines.findIndex(line => line.startsWith("## " + version + " "));
if (start < 0) throw new Error("Missing version heading");
let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end < 0) end = lines.length;
const changes = lines.slice(start + 1, end).join("\n").trim();
if (!changes) throw new Error("Empty release notes");
console.log(changes + "\n\n## Downloads\n\n" +
  "Toolbelt-" + version + "-arm64.dmg: desktop app.\n" +
  "Toolbelt-Plugin-Tester-" + version + "-arm64.dmg: standalone tester.\n" +
  "The tester tarball and versioned SDK archive are also attached.\n" +
  "Apps are ad-hoc signed, not notarized; review macOS first-open prompts.");
NOTES
cat "$release_notes"
```

Review the notes and add any release-specific installation/compatibility details. Record the
source HEAD and four local SHA-256 values outside tracked source. Then:

```sh
release_commit=$(git rev-parse HEAD)
git tag -a "$release_tag" "$release_commit" -m "Toolbelt $release_version"
git push origin "$release_tag"
gh release create "$release_tag" --repo tkarakai/toolbelt --verify-tag \
  --draft --latest=false --title "Toolbelt $release_version" --notes-file "$release_notes"
gh release upload "$release_tag" --repo tkarakai/toolbelt \
  "artifacts/Toolbelt-${release_version}-arm64.dmg"
gh release upload "$release_tag" --repo tkarakai/toolbelt \
  "artifacts/toolbelt-sdk-${sdk_version}.tgz" \
  "artifacts-tester/Toolbelt-Plugin-Tester-${release_version}-macos-arm64.tar.gz" \
  "artifacts-tester/Toolbelt-Plugin-Tester-${release_version}-arm64.dmg"
```

Upload the host DMG first. Run the download/verification section while the release is still
a draft. For prereleases, also set `--prerelease` on draft creation, or edit the draft to set
it before publishing. Confirm the exact state with `gh release view`.

Publish **one** of the following, only after verification and authorization:

```sh
# Stable app release; intentionally advances the app's update feed.
gh release edit "$release_tag" --repo tkarakai/toolbelt --draft=false --prerelease=false --latest

# Prerelease; leaves the daily app's Latest feed alone.
gh release edit "$release_tag" --repo tkarakai/toolbelt --draft=false --prerelease --latest=false
```

The app's normal updater follows GitHub Latest, not a list of prereleases. Test prerelease
updates with an explicit isolated `TOOLBELT_UPDATE_FEED`, not the installed daily app.

## Download and verify all four assets

The following works for a draft when authenticated as its publisher and for a public release.
Use the variables from preflight, with the correct version/tag and unchanged local artifacts:

```sh
release_verify_dir=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-release-verify.XXXXXX")
gh release download "$release_tag" --repo tkarakai/toolbelt --dir "$release_verify_dir" \
  --pattern "Toolbelt-${release_version}-arm64.dmg" \
  --pattern "toolbelt-sdk-${sdk_version}.tgz" \
  --pattern "Toolbelt-Plugin-Tester-${release_version}-arm64.dmg" \
  --pattern "Toolbelt-Plugin-Tester-${release_version}-macos-arm64.tar.gz"
(
set -e
for release_file in \
  "artifacts/Toolbelt-${release_version}-arm64.dmg" \
  "artifacts/toolbelt-sdk-${sdk_version}.tgz" \
  "artifacts-tester/Toolbelt-Plugin-Tester-${release_version}-macos-arm64.tar.gz" \
  "artifacts-tester/Toolbelt-Plugin-Tester-${release_version}-arm64.dmg"
do
  cmp "$release_file" "$release_verify_dir/$(basename "$release_file")"
  shasum -a 256 "$release_file" "$release_verify_dir/$(basename "$release_file")"
done
)
```

All four `cmp` calls must succeed; stop on any mismatch or missing file. Do not mistake a
printed hash for a checked equality. Also inspect the SDK's `package.json` inside its tarball
for the intended SDK version/exports and import it in a scratch Bun project. Open the downloaded
tester with a fresh named profile and a released plugin archive. Mount each downloaded DMG
read-only; verify app `CFBundleIdentifier`, `CFBundleShortVersionString` and
`codesign --verify --strict`, then detach it. Expected IDs are `io.github.tkarakai.toolbelt`
and `io.github.tkarakai.toolbelt.tester`. Use the verified local build as the expected bytes;
GitHub-generated source-code ZIP/tar archives are not these executable deliverables.

### Verify downloaded DMG contents

Define this helper in the release shell. It mounts only a new temporary directory, checks
the expected app identity/version and strict signature, then detaches on success or failure:

```sh
verify_downloaded_dmg() (
  set -e
  release_mount=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-download-mount.XXXXXX")
  trap 'hdiutil detach "$release_mount" >/dev/null 2>&1 || true; rmdir "$release_mount" 2>/dev/null || true' EXIT
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$release_mount" "$1"
  test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$release_mount/$2/Contents/Info.plist")" = "$3"
  test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$release_mount/$2/Contents/Info.plist")" = "$4"
  codesign --verify --strict "$release_mount/$2"
)
verify_downloaded_dmg "$release_verify_dir/Toolbelt-${release_version}-arm64.dmg" "Toolbelt.app" io.github.tkarakai.toolbelt "$release_version"
verify_downloaded_dmg "$release_verify_dir/Toolbelt-Plugin-Tester-${release_version}-arm64.dmg" "Toolbelt Plugin Tester.app" io.github.tkarakai.toolbelt.tester "$release_version"
```

All commands must succeed. This verifies the downloaded files rather than rebuilding new
DMGs. Keep any failing download separate for diagnosis and do not publish it.

### App updater asset selection

The current updater selects the **first release asset ending in `-arm64.dmg`**. Both app and
tester DMGs match that suffix. Therefore upload the host DMG before the tester and verify
GitHub's actual release JSON, including after resuming uploads:

```sh
gh api "repos/tkarakai/toolbelt/releases/tags/$release_tag" \
  --jq '.assets | map(select(.name | endswith("-arm64.dmg"))) | .[0].name'
```

It must print `Toolbelt-<app-version>-arm64.dmg`, not the tester DMG. The automated script
uploads in this order. A manually resumed draft can have different ordering; do not publish
it as Latest until the response selects the host DMG. To correct an unpublished draft with
the tester first, confirm `isDraft: true`, retain its exact tester bytes, then remove only
the tester DMG and upload it again after the existing host DMG:

```sh
gh release delete-asset "$release_tag" "Toolbelt-Plugin-Tester-${release_version}-arm64.dmg" --repo tkarakai/toolbelt --yes
gh release upload "$release_tag" --repo tkarakai/toolbelt "artifacts-tester/Toolbelt-Plugin-Tester-${release_version}-arm64.dmg"
```

Download/compare that asset again and rerun the selection query. Never perform this repair
on a published release. For a stable release also check
`repos/tkarakai/toolbelt/releases/latest` after publication. Keep `## Downloads` in notes:
the app displays the notes preceding that heading. The app verifies the selected release
asset digest and checks installed-plugin compatibility/busy preparation before replacing
its own bundle. Its check interval is six hours; Check now is immediate.

## Dedicated SDK release

`bun run sdk:package` only creates a local archive. Plugins depending on a URL under
`sdk-v<SDK_VERSION>` need a real release at that tag; the app's `v<app-version>` release is
a different URL, even if it contains the same SDK filename.

From an explicitly approved clean source commit containing the desired SDK/docs, install
frozen dependencies, run typecheck/tests, package, extract and test the SDK in a scratch Bun
project. Read `SDK_VERSION` from source. For changed SDK bytes choose a new SDK version in a
reviewed PR first. Do not overwrite a released SDK archive or silently move dependency URLs.

```sh
sdk_version=$(bun -p '(await import("./src/shared/package.ts")).SDK_VERSION')
sdk_tag="sdk-v${sdk_version}"
sdk_commit=$(git rev-parse HEAD)
sdk_notes=$(mktemp "${TMPDIR:-/tmp}/toolbelt-sdk-notes.XXXXXX")
cp packages/sdk/README.md "$sdk_notes"
bun run typecheck
bun test
bun run sdk:package
git tag -a "$sdk_tag" "$sdk_commit" -m "Toolbelt SDK $sdk_version"
git push origin "$sdk_tag"
gh release create "$sdk_tag" --repo tkarakai/toolbelt --verify-tag \
  --draft --latest=false --title "Toolbelt SDK $sdk_version" --notes-file "$sdk_notes"
gh release upload "$sdk_tag" --repo tkarakai/toolbelt "artifacts/toolbelt-sdk-${sdk_version}.tgz"
```

Before tagging, check absence locally/remotely as in common preflight and review `sdk_notes`;
it starts from the SDK reference, which you can trim and augment with release-specific changes.
The commands above create only the draft. Download and compare its exact bytes:

```sh
sdk_verify_dir=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-sdk-verify.XXXXXX")
gh release download "$sdk_tag" --repo tkarakai/toolbelt --dir "$sdk_verify_dir" \
  --pattern "toolbelt-sdk-${sdk_version}.tgz"
cmp "artifacts/toolbelt-sdk-${sdk_version}.tgz" "$sdk_verify_dir/toolbelt-sdk-${sdk_version}.tgz"
shasum -a 256 "$sdk_verify_dir/toolbelt-sdk-${sdk_version}.tgz"
mkdir "$sdk_verify_dir/unpacked"
tar -xzf "$sdk_verify_dir/toolbelt-sdk-${sdk_version}.tgz" -C "$sdk_verify_dir/unpacked"
(cd "$sdk_verify_dir/unpacked" && bun -e 'import {definePlugin, validatePackage} from "./src/sdk/index.ts"; if(typeof definePlugin !== "function" || typeof validatePackage !== "function") throw Error("SDK exports missing"); console.log((await Bun.file("package.json").json()).version)')
```

Stop on any comparison/import failure. The printed package version must equal `sdk_version`.
Inspect other public exports and verify consuming plugins with a frozen install after their
SDK dependency/lockfile changes. For a draft, test the downloaded archive locally rather than
assuming an unauthenticated public download URL is already available. An SDK version containing
a prerelease suffix such as `-dev.4` must be marked prerelease. Publish with `--latest=false`
**in all cases**, including a stable SDK, so an SDK-only release never takes over the app feed:

```sh
# For an SDK prerelease:
gh release edit "$sdk_tag" --repo tkarakai/toolbelt --draft=false --prerelease --latest=false
# For a stable SDK, use --prerelease=false instead, still --latest=false.
```

After publication, plugin authors change the exact public asset URL and lockfile in their
own PRs. No consumer is updated automatically. Update SDK version statements/examples in
maintained author documentation when the public SDK changes.

## Dedicated tester release

The normal app release already includes the tester; use that path unless a separate tester
distribution is explicitly wanted. There is no tester publication command and no independent
tester version field. For a tester-only release, first prepare/merge the root app version and
changelog through a release PR, or use an approved clean prerelease commit. Do not reuse an
existing tester tag/version to publish changed source.

Run common machine/access/tag preflight. Define `release_version` from root package.json as
above. Choose the separate tag and build locally:

```sh
tester_tag="tester-v${release_version}"
tester_commit=$(git rev-parse HEAD)
git tag --list "$tester_tag"
git ls-remote --tags origin "refs/tags/$tester_tag"
bun run typecheck
bun test
bun scripts/build-tester.ts
```

Stop if the tag exists. The build verifies the real tester app and mounts its signed DMG.
Open it with an isolated profile and a released plugin archive. Prepare notes outside source:

```sh
tester_notes=$(mktemp "${TMPDIR:-/tmp}/toolbelt-tester-notes.XXXXXX")
cp docs/plugin-tester.md "$tester_notes"
```

Review/trim that reference text and add the tester version, compatible host API and any
release-specific instructions. Then create the annotated tag/draft and upload only its two files:

```sh
git tag -a "$tester_tag" "$tester_commit" -m "Toolbelt Plugin Tester $release_version"
git push origin "$tester_tag"
gh release create "$tester_tag" --repo tkarakai/toolbelt --verify-tag \
  --draft --latest=false --title "Toolbelt Plugin Tester $release_version" --notes-file "$tester_notes"
gh release upload "$tester_tag" --repo tkarakai/toolbelt \
  "artifacts-tester/Toolbelt-Plugin-Tester-${release_version}-macos-arm64.tar.gz" \
  "artifacts-tester/Toolbelt-Plugin-Tester-${release_version}-arm64.dmg"
```

Download both draft assets and compare them before publishing:

```sh
tester_verify_dir=$(mktemp -d "${TMPDIR:-/tmp}/toolbelt-tester-verify.XXXXXX")
gh release download "$tester_tag" --repo tkarakai/toolbelt --dir "$tester_verify_dir" \
  --pattern "Toolbelt-Plugin-Tester-${release_version}-macos-arm64.tar.gz" \
  --pattern "Toolbelt-Plugin-Tester-${release_version}-arm64.dmg"
(
set -e
for tester_file in "Toolbelt-Plugin-Tester-${release_version}-macos-arm64.tar.gz" "Toolbelt-Plugin-Tester-${release_version}-arm64.dmg"
do
  cmp "artifacts-tester/$tester_file" "$tester_verify_dir/$tester_file"
  shasum -a 256 "$tester_verify_dir/$tester_file"
done
)
```

Stop on any mismatch. Define the helper from
[Verify downloaded DMG contents](#verify-downloaded-dmg-contents) and check the tester:

```sh
verify_downloaded_dmg "$tester_verify_dir/Toolbelt-Plugin-Tester-${release_version}-arm64.dmg" "Toolbelt Plugin Tester.app" io.github.tkarakai.toolbelt.tester "$release_version"
mkdir "$tester_verify_dir/unpacked"
tar -xzf "$tester_verify_dir/Toolbelt-Plugin-Tester-${release_version}-macos-arm64.tar.gz" -C "$tester_verify_dir/unpacked"
codesign --verify --strict "$tester_verify_dir/unpacked/Toolbelt Plugin Tester.app"
tester_profile="release-$(date +%s)"
TOOLBELT_TESTER_PROFILE="$tester_profile" "$tester_verify_dir/unpacked/Toolbelt Plugin Tester.app/Contents/MacOS/launcher"
```

The timestamped profile isolates this smoke test from other tester sessions. Quit the tester
after checking the archive; the launch command blocks until it exits. Check draft/asset state before publishing. Publish a
stable tester with the following, or replace `--prerelease=false` with `--prerelease` for a
prerelease. Always keep `--latest=false` so the app updater never sees a tester-only release:

```sh
gh release edit "$tester_tag" --repo tkarakai/toolbelt --draft=false --prerelease=false --latest=false
```

## Failure and retry rules

| Failure point | State left behind | Correct next action |
| --- | --- | --- |
| Install/check/build/DMG/SDK/tester failure before tag creation | Local generated files only | Fix through the appropriate PR; rerun preflight/build. The release is not public. |
| Local tag created, push failed | A local tag may exist; remote may or may not have received it | Check `git ls-remote` and the tag's peeled commit. If definitely local-only, remove only that local tag before retrying. Do not blindly delete remote tags. |
| Tag pushed, draft creation failed | Remote tag exists, possibly no release | Inspect `gh release view <tag>` and confirm source commit. Create the missing draft manually with `--verify-tag`, using the same intended notes/artifacts. |
| Partial upload / three automated upload failures | Remote tag and draft remain; some assets may be present | Keep the draft unpublished. Resume uploads from the exact frozen local artifacts, then download/verify every asset and ordering before publication. |
| Publish request errored or timed out | Draft may already have become public | Inspect `isDraft`, `isPrerelease`, URL and Latest before any retry. Do not infer that an error means nothing was published. |
| A published release has bad bytes/metadata/runtime behavior | Users may have downloaded the existing package | Stop further rollout, investigate and publish a corrected new version. Never force-move its tag or replace its published assets. Coordinate feed rollback explicitly. |

The release script refuses an existing local version tag, so **rerunning `bun run release`
is not a resume mechanism after tagging**. Use the manual draft/upload/publish commands at
the failed boundary. `--clobber` deletes an existing asset before re-uploading: use it only
for an explicitly verified unpublished draft, never to repair a published release. If local
artifacts were lost, do not combine rebuilt files with old uploaded hashes without checking
the whole draft again. If source must change, use a new reviewed version/tag. Do not rerun
builds while verifying uploads; their output directories are replaced.

Retain release logs, source/tag identity and byte hashes outside tracked documentation until
verification/retry is complete. Clean up only your own test processes, temporary app copies,
ports and mounted images. No step here authorizes replacing the installed daily app or
publishing on the user's behalf without their release decision.
