// Installing running's terminal UI on the PATH and its zsh hook — always in temp homes.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK, MARK, PATH_LINE, install, needsPathLine, pathsFor, probe, readZshrc, remove, wrapperScript, wrapperState, type Probe } from "../plugins/processes/install";
import { coreScript, tuiScript } from "../plugins/processes/paths";

const homes: string[] = [];
const tempHome = () => {
	const h = realpathSync(mkdtempSync(join(tmpdir(), "tb-ps-home-")));
	homes.push(h);
	return h;
};
afterEach(() => {
	for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const bun = process.execPath;
const tui = join(import.meta.dir, "../plugins/processes/running/src/main.tsx");
const onPath = (home: string, extra: Partial<Extract<Probe, { ok: true }>> = {}): Probe => ({ ok: true, pathDirs: ["/usr/bin", join(home, ".local/bin")], found: [], hookLoaded: false, ...extra });

describe("paths", () => {
	test("running-core: RUNNING_CORE_SCRIPT, then the bundle, then the vendored source", () => {
		const dir = tempHome();
		expect(coreScript(dir, { RUNNING_CORE_SCRIPT: "/x/serve.ts" })).toBe("/x/serve.ts");
		expect(coreScript(dir, {})).toBe(join(dir, "running/src/serve.ts"));
		writeFileSync(join(dir, "running-core.js"), "");
		expect(coreScript(dir, {})).toBe(join(dir, "running-core.js"));
	});
	test("the TUI: bin/running, then the vendored source", () => {
		const dir = tempHome();
		expect(tuiScript(dir)).toBe(join(dir, "running/src/main.tsx"));
		mkdirSync(join(dir, "bin"));
		writeFileSync(join(dir, "bin/running"), "");
		expect(tuiScript(dir)).toBe(join(dir, "bin/running"));
	});
	test("from source, the vendored running is there", () => {
		expect(existsSync(coreScript(undefined, {}))).toBe(true);
		expect(existsSync(tuiScript())).toBe(true);
	});
});

describe("install", () => {
	test("fresh home: wrapper, PATH line and hook, each marked", () => {
		const home = tempHome();
		const p = pathsFor(home);
		const res = install({ home, bun, tui, probe: { ok: true, pathDirs: ["/usr/bin"], found: [], hookLoaded: false } });
		expect(res.ok).toBe(true);
		expect(readFileSync(p.wrapper, "utf8")).toBe(wrapperScript(bun, tui));
		expect(statSync(p.wrapper).mode & 0o777).toBe(0o755);
		expect(readFileSync(p.zshrc, "utf8")).toBe(`${PATH_LINE} ${MARK}\n${HOOK} ${MARK}\n`);
		expect(wrapperState(p, bun, tui)).toBe("current");
		expect(readZshrc(p)).toEqual({ exists: true, hook: "toolbelt", pathLine: true, ourLines: 2 });
		expect(install({ home, bun, tui, probe: null }).message).toBe("Already installed");
	});

	test("no PATH line when ~/.local/bin is already on PATH; appends after existing text", () => {
		const home = tempHome();
		const p = pathsFor(home);
		writeFileSync(p.zshrc, "alias ll='ls -l'"); // no trailing newline
		install({ home, bun, tui, probe: onPath(home) });
		expect(readFileSync(p.zshrc, "utf8")).toBe(`alias ll='ls -l'\n${HOOK} ${MARK}\n`);
	});

	test("keeps your own hook line", () => {
		const home = tempHome();
		const p = pathsFor(home);
		writeFileSync(p.zshrc, `${HOOK}\n`);
		expect(readZshrc(p).hook).toBe("yours");
		install({ home, bun, tui, probe: onPath(home) });
		expect(readFileSync(p.zshrc, "utf8")).toBe(`${HOOK}\n`);
	});

	test("a commented-out hook doesn't count", () => {
		const home = tempHome();
		const p = pathsFor(home);
		writeFileSync(p.zshrc, `# ${HOOK}\n`);
		expect(readZshrc(p).hook).toBe("none");
	});

	test("PATH line when another running comes first", () => {
		const home = tempHome();
		const p = pathsFor(home);
		expect(needsPathLine(p, onPath(home))).toBe(false);
		expect(needsPathLine(p, onPath(home, { found: ["/usr/bin/running", p.wrapper] }))).toBe(true);
		expect(needsPathLine(p, onPath(home, { found: [p.wrapper, "/opt/x/running"] }))).toBe(false);
		expect(needsPathLine(p, { ok: false, error: "timeout" })).toBe(true);
	});

	test("someone else's ~/.local/bin/running moves aside, and Remove puts it back", () => {
		const home = tempHome();
		const p = pathsFor(home);
		mkdirSync(p.binDir, { recursive: true });
		writeFileSync(p.wrapper, "#!/bin/sh\necho mine\n");
		writeFileSync(p.zshrc, `export FOO=1\n${HOOK}\n`);
		expect(wrapperState(p, bun, tui)).toBe("foreign");
		install({ home, bun, tui, probe: onPath(home) });
		expect(readFileSync(p.backup, "utf8")).toBe("#!/bin/sh\necho mine\n");
		expect(wrapperState(p, bun, tui)).toBe("current");
		remove({ home });
		expect(readFileSync(p.wrapper, "utf8")).toBe("#!/bin/sh\necho mine\n");
		expect(existsSync(p.backup)).toBe(false);
		expect(readFileSync(p.zshrc, "utf8")).toBe(`export FOO=1\n${HOOK}\n`);
	});

	test("refuses when a backup is already in the way", () => {
		const home = tempHome();
		const p = pathsFor(home);
		mkdirSync(p.binDir, { recursive: true });
		writeFileSync(p.wrapper, "mine");
		writeFileSync(p.backup, "older");
		expect(install({ home, bun, tui, probe: null }).ok).toBe(false);
		expect(readFileSync(p.wrapper, "utf8")).toBe("mine");
	});

	test("a wrapper for another copy (the app moved) is stale, and Install updates it", () => {
		const home = tempHome();
		const p = pathsFor(home);
		install({ home, bun, tui: "/old/Toolbelt.app/bin/running", probe: onPath(home) });
		expect(wrapperState(p, bun, tui)).toBe("stale");
		install({ home, bun, tui, probe: onPath(home) });
		expect(wrapperState(p, bun, tui)).toBe("current");
	});

	test("paths with quotes survive the wrapper", () => {
		expect(wrapperScript("/a b/bun", "/it's/running")).toContain(`exec '/a b/bun' '/it'\\''s/running' "$@"`);
	});
});

describe("remove", () => {
	test("deletes exactly what install added", () => {
		const home = tempHome();
		const p = pathsFor(home);
		const before = `# my zshrc\nexport EDITOR=vim\n\nsource ~/.aliases\n`;
		writeFileSync(p.zshrc, before);
		install({ home, bun, tui, probe: { ok: true, pathDirs: ["/usr/bin"], found: [], hookLoaded: false } });
		writeFileSync(p.zshrc, readFileSync(p.zshrc, "utf8") + "alias g=git\n"); // added later by the person
		const res = remove({ home });
		expect(res.changes).toHaveLength(2);
		expect(existsSync(p.wrapper)).toBe(false);
		expect(readFileSync(p.zshrc, "utf8")).toBe(before + "alias g=git\n");
	});

	test("leaves someone else's running alone", () => {
		const home = tempHome();
		const p = pathsFor(home);
		mkdirSync(p.binDir, { recursive: true });
		writeFileSync(p.wrapper, "mine");
		expect(remove({ home }).message).toBe("Nothing of Toolbelt's to remove");
		expect(readFileSync(p.wrapper, "utf8")).toBe("mine");
	});
});

describe("probe (a real login zsh in a temp home)", () => {
	test("finds nothing in an empty home", async () => {
		const home = tempHome();
		const r = await probe(home);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.found.filter((f) => f.startsWith(home))).toEqual([]);
			expect(r.pathDirs).not.toContain(join(home, ".local/bin"));
		}
	}, 20_000);

	test("after install: on PATH, its version, the hook loaded; after remove: gone", async () => {
		const home = tempHome();
		const p = pathsFor(home);
		install({ home, bun, tui, probe: await probe(home) });
		const r = await probe(home);
		const version = JSON.parse(readFileSync(join(import.meta.dir, "../plugins/processes/running/package.json"), "utf8")).version;
		expect(r).toMatchObject({ ok: true, version, hookLoaded: true });
		if (r.ok) expect(r.found[0]).toBe(p.wrapper);
		remove({ home });
		const after = await probe(home);
		expect(after).toMatchObject({ ok: true, hookLoaded: false });
		if (after.ok) expect(after.found).not.toContain(p.wrapper);
	}, 30_000);
});
