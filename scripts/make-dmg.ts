#!/usr/bin/env bun
// The disk image Toolbelt is released as, from the app `bun run build` made:
//
//   bun run dmg     →  artifacts/Toolbelt-X.Y.Z-arm64.dmg
//
// Electrobun's own DMG holds a self-extracting stub (it unpacks the real app over itself on
// first launch): it carries no CFBundleShortVersionString and its signature doesn't verify, so
// the updater couldn't check it. This one holds the real app, taken from the update bundle
// (artifacts/stable-macos-arm64-Toolbelt.app.tar.zst), with its version in Info.plist and the
// bundle signed ad hoc (the binaries inside keep their own signatures), next to an
// Applications link to drag it onto. LZMA-compressed (ULMO): about a third smaller than UDZO.
import { $ } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BUNDLE_ID = "io.github.tkarakai.toolbelt";

export async function makeDmg(root = join(import.meta.dir, "..")): Promise<string> {
	const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	const bundle = join(root, "artifacts/stable-macos-arm64-Toolbelt.app.tar.zst");
	if (!existsSync(bundle)) throw new Error(`${bundle} is missing — run \`bun run build\` first`);
	const out = join(root, `artifacts/Toolbelt-${version}-arm64.dmg`);

	const stage = mkdtempSync(join(tmpdir(), "toolbelt-dmg-"));
	try {
		console.log("Disk image: extracting the built app");
		const tar = join(stage, "app.tar");
		writeFileSync(tar, Bun.zstdDecompressSync(readFileSync(bundle)));
		const vol = join(stage, "Toolbelt");
		await $`mkdir -p ${vol} && tar -xf ${tar} -C ${vol}`;
		rmSync(tar);
		const app = join(vol, "Toolbelt.app");
		const plist = join(app, "Contents/Info.plist");
		const built = JSON.parse(readFileSync(join(app, "Contents/Resources/version.json"), "utf8"));
		if (built.version !== version) throw new Error(`the built app is ${built.version}, package.json says ${version} — rebuild`);
		if (built.channel !== "stable") throw new Error(`the built app is on the ${built.channel} channel, expected stable`);
		const id = (await $`/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" ${plist}`.text()).trim();
		if (id !== BUNDLE_ID) throw new Error(`the built app is ${id}, expected ${BUNDLE_ID}`);
		await $`/usr/libexec/PlistBuddy -c ${`Delete :CFBundleShortVersionString`} ${plist}`.quiet().nothrow();
		await $`/usr/libexec/PlistBuddy -c ${`Add :CFBundleShortVersionString string ${version}`} ${plist}`;
		console.log("Disk image: signing and verifying the app");
        for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
            await $`/usr/bin/plutil -replace ${key} -string ToolBelt ${plist}`;
        }
		await $`/usr/bin/codesign --force --sign - ${app}`;
		await $`/usr/bin/codesign --verify --strict ${app}`;
		symlinkSync("/Applications", join(vol, "Applications"));
		console.log(`Creating ${out}`);
		// Match Running's DMG builder rather than inheriting hdiutil's host-dependent default.
		await $`/usr/bin/hdiutil create -volname Toolbelt -srcfolder ${vol} -fs APFS -ov -format ULMO ${out}`;
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	console.log("Disk image: mounting and verifying the download");
	await verifyDmg(out, version);
	return out;
}

/** Mount it and check what the updater will check: bundle id, version, signature. */
export async function verifyDmg(dmg: string, version: string) {
	const mnt = mkdtempSync(join(tmpdir(), "toolbelt-dmg-check-"));
	console.log(`Verifying ${dmg}`);
	let mounted = false;
	try {
		// A newly created image can still be busy when DiskImages first opens it on CI.
		// Retry only transient resource errors; malformed images and other failures stop here.
		for (let attempt = 1; ; attempt++) {
			const result = await $`/usr/bin/hdiutil attach -nobrowse -readonly -noautoopen -mountpoint ${mnt} ${dmg}`.nothrow();
			if (result.exitCode === 0) {
				mounted = true;
				break;
			}
			const detail = result.stderr.toString().trim();
			if (attempt === 5 || !/Resource temporarily unavailable|Resource busy/i.test(detail)) {
				throw new Error(`mounting ${dmg} failed (attempt ${attempt}): ${detail}`);
			}
			const delay = 1000 * 2 ** (attempt - 1);
			console.warn(`Disk image temporarily busy; retrying mount in ${delay / 1000}s (attempt ${attempt}/5)`);
			await Bun.sleep(delay);
		}
		const plist = join(mnt, "Toolbelt.app/Contents/Info.plist");
		const v = (await $`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" ${plist}`.text()).trim();
		const id = (await $`/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" ${plist}`.text()).trim();
		if (v !== version || id !== BUNDLE_ID) throw new Error(`${dmg} holds ${id} ${v}, expected ${BUNDLE_ID} ${version}`);
		await $`/usr/bin/codesign --verify --strict ${join(mnt, "Toolbelt.app")}`;
	} finally {
		if (mounted) await $`/usr/bin/hdiutil detach -force ${mnt}`.quiet().nothrow();
		rmSync(mnt, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		console.log(await makeDmg());
	} catch (e) {
		console.error(`✗ ${(e as Error).message}`);
		// Bun's ShellError.message contains only the exit code; quiet commands keep the
		// useful diagnostic (codesign, tar, hdiutil) in these captured streams.
		if (e instanceof $.ShellError) {
			if (e.stdout.length) console.error(e.stdout.toString().trimEnd());
			if (e.stderr.length) console.error(e.stderr.toString().trimEnd());
		}
		process.exit(1);
	}
}
