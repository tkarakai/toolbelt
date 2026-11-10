#!/usr/bin/env bun
// Create a GitHub release for the version in package.json.
//
//   bun run release            tag vX.Y.Z on main and publish the GitHub release
//   bun run release --dry-run  check and build everything, show the notes, publish nothing
//
// Preconditions (checked): on `main`, clean, up to date with origin/main; the tag doesn't
// exist yet; CHANGELOG.md has a `## X.Y.Z — …` section. Stop `bun run dev` first: the build
// shares Hutch's lock with it.
//
// Three downloads, matching Running: the desktop DMG, a Bun TUI bundle and a standalone TUI.
// The app finds Toolbelt-X.Y.Z-arm64.dmg (scripts/make-dmg.ts)
// through GitHub's "latest release" (src/bun/updater.ts): keep the `-arm64.dmg` name, and the
// `## Downloads` heading that ends the part of the notes the app shows.
import { $ } from "bun";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BUNDLE_ID, makeDmg } from "./make-dmg";
import { makeTerminalArchives } from "./make-terminal-archives";

const dry = process.argv.includes("--dry-run");
process.chdir(join(import.meta.dir, ".."));

const fail = (msg: string): never => {
	console.error(`✗ ${msg}`);
	process.exit(1);
};
const ok = (msg: string) => console.log(`✓ ${msg}`);

const version: string = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
const repo = "tkarakai/toolbelt";

// ── git state ────────────────────────────────────────────────────────────
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main" && !dry) fail(`on branch "${branch}" — releases are made from main`);
if ((await $`git status --porcelain`.text()).trim() && !dry) fail("working tree has uncommitted changes");
if (!dry) {
	await $`git fetch --quiet --tags origin main`;
	const [head, remote] = [(await $`git rev-parse HEAD`.text()).trim(), (await $`git rev-parse origin/main`.text()).trim()];
	if (head !== remote) fail("main differs from origin/main — pull (or merge your PR) first");
}
if ((await $`git tag --list ${tag}`.text()).trim()) fail(`tag ${tag} already exists — bump the version in a release PR`);
ok(dry ? `dry run for ${tag} (git state checks relaxed)` : `main is clean and up to date; releasing ${tag}`);

// ── changelog section ────────────────────────────────────────────────────
const changelog = readFileSync("CHANGELOG.md", "utf8");
const start = changelog.search(new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b.*$`, "m"));
if (start < 0) fail(`CHANGELOG.md has no "## ${version} — …" section`);
const afterHeading = changelog.indexOf("\n", start) + 1;
const next = changelog.slice(afterHeading).search(/^## /m);
const changes = changelog.slice(afterHeading, next < 0 ? undefined : afterHeading + next).trim();
if (!changes) fail(`the ${version} section in CHANGELOG.md is empty`);
ok(`changelog: ${changes.split("\n").length} lines`);

// ── checks + build ───────────────────────────────────────────────────────
if ((await $`uname -m`.text()).trim() !== "arm64") fail("build on Apple silicon (the app is arm64)");
await $`bun run typecheck`.quiet().catch(() => fail("typecheck failed (run `bun run typecheck`)"));
ok("typecheck");
await $`bun test`.quiet().catch(() => fail("tests failed (run `bun test`)"));
ok("tests");
await $`bun run build`.quiet().catch(() => fail("build failed (run `bun run build`; is `bun run dev` running?)"));
const asset = await makeDmg().catch((e) => fail(`disk image: ${(e as Error).message}`));
const mb = (Number((await $`stat -f %z ${asset}`.text()).trim()) / 1048576).toFixed(1);
ok(`built ${asset} (${mb} MB): Toolbelt ${version}, ${BUNDLE_ID}, signature verifies`);
const terminalAssets = await makeTerminalArchives().catch((e) => fail(`terminal archives: ${(e as Error).message}`));
const assets = [asset, ...terminalAssets];
ok("built and verified both terminal archives (version, Bun runtime, zsh hook)");

// ── release notes ────────────────────────────────────────────────────────
const notes = `${changes}

## Downloads

**\`${basename(asset)}\`** — Toolbelt for Apple silicon Macs. Open the disk image and drag
**Toolbelt** to Applications. From then on it updates itself: when a new version is out, its
menu bar icon shows a red badge and Toolbelt's page offers the update.

> **First launch:** the app isn't signed by an Apple developer account, so macOS blocks the
> first open of a downloaded copy. Either right-click Toolbelt in Applications → **Open** →
> **Open**, or clear the flag once: \`xattr -dr com.apple.quarantine /Applications/Toolbelt.app\`
> (downloading with \`gh release download ${tag} --repo ${repo}\` avoids it too).

The other two downloads contain the same patched \`running\` terminal UI bundled with
Toolbelt (upstream version ${JSON.parse(readFileSync("plugins/processes/running/package.json", "utf8")).version}).
Their filenames use the Toolbelt release version. Each archive contains one executable,
\`running\`: put it on your PATH (e.g. \`~/.local/bin\`), then add
\`eval "$(command running init)"\` to \`~/.zshrc\`.

**\`${basename(terminalAssets[0])}\`** — the small bundle, needs [Bun](https://bun.sh).
Built and tested with **Bun ${Bun.version}**; that is the version it expects. If another
Bun version misbehaves, use the standalone build. \`running --help\` shows both versions.

**\`${basename(terminalAssets[1])}\`** — self-contained, Bun ${Bun.version} embedded,
Apple silicon only. Nothing else to install.

> **Gatekeeper:** the standalone binary is not signed by an Apple developer account.
> Download with \`gh release download ${tag} --repo ${repo}\`, or clear the flag once:
> \`xattr -d com.apple.quarantine running\`.
`;

if (dry) {
	console.log(`\n(dry run) would tag ${tag}, push it, create a draft release, upload ${assets.map((file) => basename(file)).join(", ")}`);
	console.log(`(with retries), then publish.\n\n--- notes ---\n${notes}`);
	process.exit(0);
}

// ── tag, draft, upload (with retries), publish ───────────────────────────
await $`git tag -a ${tag} -m ${"Toolbelt " + version}`;
await $`git push origin ${tag}`;
ok(`pushed tag ${tag}`);
const notesFile = join(mkdtempSync(join(tmpdir(), "toolbelt-release-")), "notes.md");
writeFileSync(notesFile, notes);
// A draft first: a failed upload can be retried without losing the release.
await $`gh release create ${tag} --repo ${repo} --verify-tag --draft --title ${"Toolbelt " + version} --notes-file ${notesFile}`.quiet();
ok("draft release created");
for (const asset of assets) {
	for (let attempt = 1; ; attempt++) {
		const res = await $`gh release upload ${tag} --repo ${repo} --clobber ${asset}`.nothrow().quiet();
		if (res.exitCode === 0) {
			ok(`uploaded ${basename(asset)}`);
			break;
		}
		if (attempt === 3) fail(`upload failed 3 times — the draft release is kept; retry: gh release upload ${tag} --repo ${repo} --clobber ${asset}`);
		console.log(`  upload attempt ${attempt} failed, retrying…`);
		await Bun.sleep(3000 * attempt);
	}
}
await $`gh release edit ${tag} --repo ${repo} --draft=false --latest`.quiet();
ok(`published ${tag}`);
console.log((await $`gh release view ${tag} --repo ${repo} --json url --jq .url`.text()).trim());
