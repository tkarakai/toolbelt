// The Processes plugin's list model: sections, folders, nesting, sorting, apps, search.
import { describe, expect, test } from "bun:test";
import type { ProcRow, Snapshot } from "../plugins/processes/core";
import { agentState, build, sortTree, stripAnsi } from "../plugins/processes/model";
import type { GroupLabel } from "../src/shared/protocol";

const job = (p: Partial<ProcRow> & { pid: number }): ProcRow => ({
	kind: "term", command: `cmd${p.pid}`, argvCommand: `cmd${p.pid}`, displayArgv: [], source: "typed", leaderGone: false, cwd: "/w/a", listen: [], where: "Orca",
	tty: "", stat: "S", etimeSec: 100, rssKb: 1024, cpu: 0, pidCount: 1, members: [], termLabel: "", shellAlive: true, ...p,
});
const snap = (rows: ProcRow[], extra: Partial<Snapshot> = {}): Snapshot => ({ at: 0, rows, kept: [], probes: [], branches: {}, sort: { key: "started", desc: true }, ...extra });
const opts = { query: "", showAll: false, sort: "started" as const, desc: false };
const labels = (g: unknown) => (g as GroupLabel[]).map((l) => (typeof l === "string" ? l : l.label));

describe("grouping", () => {
	test("sections by where (terminals before apps, detached labelled), then folders with branch", () => {
		const s = snap(
			[job({ pid: 1, where: "detached", cwd: "/w/b" }), job({ pid: 2, where: "Orca" }), job({ pid: 3, where: "Code", kind: "app" }), job({ pid: 4, where: "Orca", cwd: "/w/b" })],
			{ branches: { "/w/a": "main" } },
		);
		const all = build(s, { ...opts, showAll: true }).rows;
		expect(all.map((r) => labels(r.group))).toEqual([
			["Detached", "/w/b"],
			["Orca", "/w/a"],
			["Orca", "/w/b"],
			["Code", "/w/a"],
		]);
		const g = all[0].group as Exclude<GroupLabel, string>[];
		expect(g[0].tag).toBe("no terminal");
		expect((all[1].group as Exclude<GroupLabel, string>[])[1].sub).toBe("main");
		expect((all[3].group as Exclude<GroupLabel, string>[])[0]).toMatchObject({ tag: "app", muted: true });
	});

	test("apps are hidden unless asked for, and counted", () => {
		const b = build(snap([job({ pid: 1 }), job({ pid: 2, kind: "app", where: "Code" })]), opts);
		expect(b.rows.map((r) => r.id)).toEqual(["1"]);
		expect(b.hiddenApps).toBe(1);
	});

	test("jobs started from another job nest under it, which opens", () => {
		const rows = build(snap([job({ pid: 1 }), job({ pid: 2, parentRow: 1 })]), opts).rows;
		expect(rows.map((r) => r.id)).toEqual(["1"]);
		expect(rows[0].open).toBe(true);
		expect(rows[0].children?.map((c) => c.id)).toEqual(["2"]);
	});

	test("members nest by parent pid", () => {
		const m = (pid: number, ppid: number) => ({ pid, ppid, depth: 0, displayArgv: [], argvCommand: `m${pid}`, cwd: "/w/a", listen: [], tty: "", stat: "S", etimeSec: 1, rssKb: 1, cpu: 0, pidCount: 1 });
		const rows = build(snap([job({ pid: 1, members: [m(10, 1), m(11, 10), m(12, 1)] })]), opts).rows;
		expect(rows[0].children?.map((c) => c.id)).toEqual(["10", "12"]);
		expect(rows[0].children?.[0].children?.map((c) => c.id)).toEqual(["11"]);
		expect(rows[0].open).toBeUndefined();
	});
});

describe("sorting and search", () => {
	test("by started: newest first ascending, oldest first descending", () => {
		const s = snap([job({ pid: 1, etimeSec: 50 }), job({ pid: 2, etimeSec: 10 })]);
		expect(build(s, opts).rows.map((r) => r.id)).toEqual(["2", "1"]);
		expect(build(s, { ...opts, desc: true }).rows.map((r) => r.id)).toEqual(["1", "2"]);
	});

	test("by memory, sections order by their total", () => {
		const s = snap([job({ pid: 1, where: "A", rssKb: 10 }), job({ pid: 2, where: "B", rssKb: 500 })]);
		expect(build(s, { ...opts, sort: "memory", desc: true }).rows.map((r) => r.id)).toEqual(["2", "1"]);
	});

	test("search finds pids, ports, member commands; a member hit opens its job", () => {
		const s = snap([
			job({ pid: 50493, listen: [{ pid: 50493, port: 3000, host: "localhost" }] }),
			job({ pid: 7, members: [{ pid: 70, ppid: 7, depth: 0, displayArgv: [], argvCommand: "vite --port 5173", cwd: "/w/a", listen: [], tty: "", stat: "S", etimeSec: 1, rssKb: 1, cpu: 0, pidCount: 1 }] }),
		]);
		expect(build(s, { ...opts, query: "504" }).rows.map((r) => r.id)).toEqual(["50493"]);
		expect(build(s, { ...opts, query: ":3000" }).rows.map((r) => r.id)).toEqual(["50493"]);
		const hit = build(s, { ...opts, query: "vite" }).rows;
		expect(hit.map((r) => r.id)).toEqual(["7"]);
		expect(hit[0].open).toBe(true);
	});

	test("launchers that exited and guessed commands say so", () => {
		const r = build(snap([job({ pid: 1, leaderGone: true, pidCount: 3, source: "history" })]), opts).rows[0];
		const name = r.cells.name as { text: string; sub: string };
		expect(name.text.startsWith("⤷ ")).toBe(true);
		expect(name.sub).toContain("3 left running");
		expect(name.sub).toContain("guessed from history");
	});
});

test("agent state: working, or idle for how long", () => {
	expect(agentState({ harness: "codex", status: "working" })).toBe("working");
	expect(agentState({ harness: "codex", status: "idle", lastActive: 1_700_000_000_000 }, 1_700_000_000_000 + 125_000)).toBe("idle 2m");
});

test("sortTree keeps parents above children", () => {
	const m = (pid: number, ppid: number, cpu: number) => ({ pid, ppid, depth: 0, displayArgv: [], argvCommand: "", cwd: "", listen: [], tty: "", stat: "", etimeSec: 0, rssKb: 0, cpu, pidCount: 1 });
	const out = sortTree([m(2, 1, 1), m(3, 2, 9), m(4, 1, 5)], (x) => x.cpu, (a, b) => (b as number) - (a as number));
	expect(out.map((x) => x.pid)).toEqual([4, 2, 3]);
});

test("stripAnsi removes colors and cursor codes", () => {
	expect(stripAnsi("\x1b[32mok\x1b[0m \x1b[2K\x1b]0;title\x07done")).toBe("ok done");
});
