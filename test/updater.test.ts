import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BUNDLE_ID, INTERVAL, SOON, Updater, bundleOf, installProblem, isDue, isNewer, parseRelease, releaseNotes, smoothSpeed, type UpdateState, type Shell } from "../src/bun/updater";

const release = (over: Record<string, unknown> = {}) => ({
	tag_name: "v0.2.0",
	html_url: "https://github.com/tkarakai/toolbelt/releases/tag/v0.2.0",
	published_at: "2026-11-01T10:00:00Z",
	body: "### Added\n\n- Updates itself\n\n## Downloads\n\nDrag it to Applications.",
	assets: [
		{ name: "Toolbelt-0.2.0-arm64.dmg", size: 1234, browser_download_url: "https://example.test/Toolbelt-0.2.0-arm64.dmg", digest: "sha256:ABCDEF" },
		{ name: "other.zip", size: 1, browser_download_url: "https://example.test/other.zip" },
	],
	...over,
});

describe("parsing", () => {
	test("a GitHub release", () => {
		expect(parseRelease(release())).toEqual({
			version: "0.2.0",
			notes: "### Added\n\n- Updates itself",
			page: "https://github.com/tkarakai/toolbelt/releases/tag/v0.2.0",
			dmg: "https://example.test/Toolbelt-0.2.0-arm64.dmg",
			size: 1234,
			sha256: "abcdef",
			published: Date.parse("2026-11-01T10:00:00Z"),
		});
	});
	test("no v prefix, no digest, no date", () => {
		const r = parseRelease(release({ tag_name: "1.0.0", published_at: null, assets: [{ name: "Toolbelt-1.0.0-arm64.dmg", size: 5, browser_download_url: "u" }] }));
		expect(r).toMatchObject({ version: "1.0.0", sha256: null, published: null });
	});
	test("no disk image", () => {
		expect(() => parseRelease(release({ assets: [] }))).toThrow("The release has no disk image");
		expect(() => parseRelease({ message: "Not Found" })).toThrow("isn't a release");
	});
	test("notes stop at Downloads", () => {
		expect(releaseNotes("a\n\n## Downloads\nb")).toBe("a");
		expect(releaseNotes("  just notes \n")).toBe("just notes");
		expect(releaseNotes(null)).toBe("");
	});
});

test("isNewer", () => {
	expect(isNewer("0.2.0", "0.1.9")).toBe(true);
	expect(isNewer("0.10.0", "0.9.0")).toBe(true);
	expect(isNewer("1.0", "1.0.0")).toBe(false);
	expect(isNewer("1.0.1", "1.0")).toBe(true);
	expect(isNewer("1.2.3-dev", "1.2.3")).toBe(false);
	expect(isNewer("1.2.3", "1.2.4")).toBe(false);
	expect(isNewer("0.0.0", "0.0.0")).toBe(false);
});

test("schedule", () => {
	expect(isDue(null, 0)).toBe(true);
	expect(isDue(0, INTERVAL - 1)).toBe(false);
	expect(isDue(0, INTERVAL)).toBe(true);
	expect(isDue(0, SOON - 1, SOON)).toBe(false);
	expect(isDue(0, SOON, SOON)).toBe(true);
});

test("speed smoothing", () => {
	expect(smoothSpeed(0, 100)).toBe(100);
	expect(smoothSpeed(100, 200)).toBe(130);
});

test("bundle path and install problems", () => {
	expect(bundleOf("/Applications/Toolbelt.app/Contents/MacOS/bun")).toBe("/Applications/Toolbelt.app");
	expect(bundleOf("/opt/homebrew/bin/bun")).toBeNull();
	const yes = () => true;
	expect(installProblem("/Applications/Toolbelt.app", yes)).toBeNull();
	expect(installProblem(null, yes)).toContain("isn't an app bundle");
	expect(installProblem("/private/var/folders/x/AppTranslocation/ABC/d/Toolbelt.app", yes)).toContain("Applications folder");
	expect(installProblem("/Volumes/Toolbelt/Toolbelt.app", yes)).toContain("Applications folder");
	expect(installProblem("/Applications/Toolbelt.app", () => false)).toBe("Toolbelt can't write to /Applications.");
});

// ── the updater, with a fake network and shell ───────────────────────────
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "tb-updater-test-"));
	dirs.push(d);
	return d;
};

function setup(opts: { version?: string; channel?: string; feed?: string; dmg?: Uint8Array; info?: Record<string, unknown>; feedStatus?: number; sha?: string } = {}) {
	const dir = tmp();
	const app = join(dir, "Apps/Toolbelt.app");
	mkdirSync(join(app, "Contents"), { recursive: true });
	writeFileSync(join(app, "Contents/which"), "old");
	const dmgBytes = opts.dmg ?? new Uint8Array(300_000).fill(7);
	const digest = opts.sha ?? createHash("sha256").update(dmgBytes).digest("hex");
	const rel = release({ assets: [{ name: "Toolbelt-0.2.0-arm64.dmg", size: dmgBytes.length, browser_download_url: "https://example.test/dmg", digest: `sha256:${digest}` }] });
	const calls: string[][] = [];
	const states: UpdateState[] = [];
	let relaunched: string | null = null;
	const fakeFetch = (async (url: string) => {
		if (url === "https://example.test/dmg") {
			// In chunks, a little apart, like a real download.
			const body = new ReadableStream<Uint8Array>({
				async start(c) {
					for (let i = 0; i < dmgBytes.length; i += 100_000) {
						c.enqueue(dmgBytes.subarray(i, i + 100_000));
						await Bun.sleep(1);
					}
					c.close();
				},
			});
			return new Response(body, { headers: { "content-length": String(dmgBytes.length) } });
		}
		return Response.json(rel, { status: opts.feedStatus ?? 200 });
	}) as unknown as typeof fetch;
	const fakeSh: Shell = async (exe, ...args) => {
		calls.push([exe, ...args]);
		if (exe.endsWith("hdiutil") && args[0] === "attach") {
			const mnt = args[args.indexOf("-mountpoint") + 1];
			mkdirSync(join(mnt, "Toolbelt.app/Contents"), { recursive: true });
			writeFileSync(join(mnt, "Toolbelt.app/Contents/which"), "new");
		}
		if (exe.endsWith("ditto")) cpSync(args[0], args[1], { recursive: true });
		return "";
	};
	let now = 1_000_000_000_000;
	const u = new Updater({
		version: opts.version ?? "0.1.0",
		channel: opts.channel ?? "stable",
		feed: opts.feed,
		stateFile: join(dir, "config/update.json"),
		appPath: app,
		onChange: (s) => states.push(s),
		relaunch: (p) => void (relaunched = p),
		fetch: fakeFetch,
		sh: fakeSh,
		now: () => now,
		readInfo: async () => opts.info ?? { CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: "0.2.0" },
		relaunchDelay: 0,
	});
	return { u, dir, app, calls, states, relaunched: () => relaunched, advance: (ms: number) => (now += ms) };
}

describe("updater", () => {
	test("dev builds don't update, unless a feed is set", () => {
		expect(setup({ channel: "dev" }).u.enabled).toBe(false);
		expect(setup({ channel: "dev" }).u.checkIfDue()).toBe(false);
		expect(setup({ channel: "dev", feed: "http://127.0.0.1:1/release.json" }).u.enabled).toBe(true);
		expect(setup({ channel: "stable" }).u.enabled).toBe(true);
	});

	test("check finds a newer release and remembers when", async () => {
		const { u, dir } = setup();
		await u.check();
		const s = u.state();
		expect(s.available?.version).toBe("0.2.0");
		expect(s.lastError).toBeNull();
		expect(s.lastChecked).not.toBeNull();
		expect(JSON.parse(readFileSync(join(dir, "config/update.json"), "utf8"))).toEqual({ lastChecked: s.lastChecked, lastAttempt: s.lastChecked });
	});

	test("up to date: latest known, nothing available", async () => {
		const { u } = setup({ version: "0.2.0" });
		await u.check();
		expect(u.state()).toMatchObject({ available: null, latest: { version: "0.2.0" } });
	});

	test("a failed check keeps the error and counts as an attempt", async () => {
		const { u, advance } = setup({ feedStatus: 403 });
		await u.check();
		expect(u.state()).toMatchObject({ lastError: "GitHub answered 403", lastChecked: null });
		expect(u.checkIfDue()).toBe(false); // waits for the next regular check
		advance(INTERVAL);
		expect(u.checkIfDue()).toBe(true);
	});

	test("installs: downloads, verifies, swaps the bundle, relaunches", async () => {
		const { u, app, calls, states, relaunched } = setup();
		await u.check();
		await u.install();
		expect(states.map((s) => s.phase.kind).filter((k, i, a) => k !== a[i - 1])).toEqual(["idle", "downloading", "verifying", "installing", "relaunching"]);
		const last = states.findLast((s) => s.phase.kind === "downloading")!.phase;
		expect(last).toMatchObject({ received: 300_000, total: 300_000 });
		expect(readFileSync(join(app, "Contents/which"), "utf8")).toBe("new");
		expect(relaunched()).toBe(app);
		expect(calls.map((c) => c[0].split("/").pop() + " " + c[1])).toEqual(["hdiutil attach", "codesign --verify", "ditto " + calls[2][1], "xattr -dr", "hdiutil detach"]);
		// Nothing left behind next to the app.
		expect(require("node:fs").readdirSync(join(app, "..")).sort()).toEqual(["Toolbelt.app"]);
	});

	test("a damaged download fails and changes nothing", async () => {
		const { u, app, relaunched } = setup({ sha: "00".repeat(32) });
		await u.check();
		await u.install();
		expect(u.state().phase).toEqual({ kind: "failed", message: "The download is damaged (checksum mismatch). Try again." });
		expect(readFileSync(join(app, "Contents/which"), "utf8")).toBe("old");
		expect(relaunched()).toBeNull();
		u.dismiss();
		expect(u.state().phase.kind).toBe("idle");
	});

	test("refuses a disk image with another app or version", async () => {
		for (const [info, msg] of [
			[{ CFBundleIdentifier: "com.example.other", CFBundleShortVersionString: "0.2.0" }, "a different app"],
			[{ CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: "0.1.5" }, "a different version"],
		] as const) {
			const { u, app, calls } = setup({ info });
			await u.check();
			await u.install();
			expect(u.state().phase).toMatchObject({ kind: "failed" });
			expect((u.state().phase as { message: string }).message).toContain(msg);
			expect(readFileSync(join(app, "Contents/which"), "utf8")).toBe("old");
			expect(calls.at(-1)?.slice(0, 2)).toEqual(["/usr/bin/hdiutil", "detach"]); // unmounted
		}
	});

	test("refuses when the app's folder isn't writable", async () => {
		const s = setup();
		const u = new Updater({ ...(s.u as unknown as { o: object }).o, writable: () => false } as never);
		await u.check();
		await u.install();
		expect(u.state().phase).toMatchObject({ kind: "failed", message: expect.stringContaining("can't write to") });
		expect(existsSync(s.app)).toBe(true);
	});

	test("cancel during the download goes back to idle", async () => {
		const { u, app } = setup({ dmg: new Uint8Array(5_000_000) });
		await u.check();
		const run = u.install();
		await Bun.sleep(5);
		expect(u.state().phase.kind).toBe("downloading");
		u.cancel();
		await run;
		expect(u.state().phase.kind).toBe("idle");
		expect(readFileSync(join(app, "Contents/which"), "utf8")).toBe("old");
	});
});
