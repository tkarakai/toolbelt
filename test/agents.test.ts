// The agent interface (docs/agent-interface.md): access levels, the serializer, the core against a fake
// host, and the MCP socket and CLI end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSettings, ceilingOf, declaredAccess, defaultAccess, effectiveAccess } from "../src/shared/agents";
import { parseManifest, type Manifest, type Node } from "../src/shared/protocol";
import type { PluginInfo } from "../src/shared/plugin-state";
import { MASK, redact, treeJson, treeText } from "../src/bun/agent/serialize";
import { AgentCore, type AgentHost } from "../src/bun/agent/core";
import { AgentServer } from "../src/bun/agent/server";
import { AuditLog } from "../src/bun/agent/audit";
import { createAgentInterface } from "../src/bun/agent";

const manifest = (id: string, extra: Partial<Manifest> = {}): Manifest => ({
	id,
	name: id[0].toUpperCase() + id.slice(1),
	icon: "box",
	version: "1.0.0",
	protocol: 1,
	entry: "index.js",
	screens: [{ id: "main", title: "Main", default: true }, { id: "settings", title: "Settings" }],
	agent: { access: "read" },
	...extra,
});

const page = (rows: number, extra: Partial<Extract<Node, { type: "page" }>> = {}): Node => ({
	type: "page",
	summary: `${rows} things`,
	filters: [{ id: "kind", label: "Kind", options: [{ value: "a", label: "Apples" }, { value: "b", label: "Bananas" }], selected: ["a"] }],
	actions: [{ id: "refresh", label: "Refresh" }],
	children: [
		{
			type: "table",
			id: "things",
			columns: [{ key: "name", title: "Name" }, { key: "due", title: "Due" }],
			actions: [{ id: "done", label: "Done" }, { id: "gone", label: "Hidden", disabled: true }],
			sections: [{ id: "today", label: "Today" }, { id: "later", label: "Later" }],
			rows: Array.from({ length: rows }, (_, i) => ({
				id: `t${i}`,
				group: "today",
				cells: { name: `Thing ${i}`, due: { text: "", at: Date.UTC(2026, 10, 25, 12) } },
				details: [{ label: "Note", value: `note ${i}` }],
			})),
		},
		{
			type: "form",
			id: "secrets",
			title: "Secrets",
			fields: [
				{ type: "text", id: "token", label: "Token", value: "sk-123", sensitive: true },
				{ type: "environment", id: "env", label: "Env", value: [{ key: "API_KEY", value: "abc", selected: true, secret: true }, { key: "MODE", value: "dev", selected: true, secret: false }] },
			],
		},
	],
	...extra,
});

describe("access levels", () => {
	test("a declared level is the default and the most the person may allow", () => {
		expect(declaredAccess({ agent: { access: "none" } })).toBe("none");
		expect(effectiveAccess("read")).toBe("read");
		expect(effectiveAccess("read", "act")).toBe("read");
		expect(effectiveAccess("act", "none")).toBe("none");
		expect(effectiveAccess("none", "read")).toBe("none");
	});
	test("undeclared plugins get no access unless the person allows reading", () => {
		expect(declaredAccess({})).toBeNull();
		expect(declaredAccess({ agent: { access: "bogus" } })).toBeNull();
		expect([ceilingOf(null), defaultAccess(null)]).toEqual(["read", "none"]);
		expect(effectiveAccess(null)).toBe("none");
		expect(effectiveAccess(null, "read")).toBe("read");
		expect(effectiveAccess(null, "act")).toBe("read");
	});
	test("saved settings are checked", () => {
		expect(agentSettings({ enabled: "yes", access: { a: "read", b: "all", c: "none" } })).toEqual({ enabled: false, access: { a: "read", c: "none" } });
		expect(agentSettings(undefined)).toEqual({ enabled: false, access: {} });
	});
	test("the manifest key is validated", () => {
		expect(parseManifest(manifest("x", { agent: { access: "none" } })).agent).toEqual({ access: "none" });
		expect(() => parseManifest({ ...manifest("x"), agent: { access: "write" } })).toThrow("agent.access");
		expect(() => parseManifest({ ...manifest("x"), agent: "none" })).toThrow("agent.access");
	});
});

describe("serializer", () => {
	test("masks sensitive fields and secret environment values", () => {
		const r = JSON.stringify(redact(page(1)));
		expect(r).not.toContain("sk-123");
		expect(r).not.toContain('"abc"');
		expect(r).toContain('"dev"');
		const { text } = treeText(page(1));
		expect(text).toContain(`Token: ${MASK}`);
		expect(text).toContain(`API_KEY=${MASK}`);
		expect(text).toContain("MODE=dev");
	});
	test("text lists sections, rows, details, enabled actions and shared view state", () => {
		const { text, viewState } = treeText(page(2), { now: Date.UTC(2026, 10, 25, 10) });
		expect(text).toContain("Summary: 2 things");
		expect(text).toContain("Filter Kind: Apples");
		expect(text).toContain("Toolbar actions: Refresh");
		expect(text).toContain("Row actions: Done");
		expect(text).not.toContain("Hidden");
		expect(text).toContain("### Today");
		expect(text).toContain("- Thing 1 · ");
		expect(text).toContain("{id: t1}");
		expect(text).toContain("Note: note 1");
		expect(text).toContain("(in 2h)");
		expect(text).toContain("Empty sections: Later");
		expect(viewState).toEqual(['filter "Kind" = Apples']);
		expect(treeText(page(2), { details: false }).text).not.toContain("note 1");
	});
	test("rows in sub-sections sit under their parent; empty sub-sections name it", () => {
		const tree: Node = {
			type: "table",
			id: "t",
			columns: [{ key: "name", title: "Name" }],
			sections: [{ id: "up", label: "Upcoming", sections: [{ id: "week", label: "This week" }, { id: "later", label: "Later" }] }, { id: "done", label: "Done" }],
			rows: [{ id: "a", group: "week", cells: { name: "Alpha" } }],
		};
		const { text } = treeText(tree);
		expect(text).toContain("### Upcoming › This week\n- Alpha");
		expect(text).toContain("Empty sections: Upcoming › Later, Done");
	});
	test("pages long tables in text and JSON", () => {
		const first = treeText(page(250)).text;
		expect(first).toContain("Thing 99 ");
		expect(first).not.toContain("Thing 100 ");
		expect(first).toContain('read again with table "things" and offset 100');
		const next = treeText(page(250), { table: "things", offset: 200, maxRows: 100 }).text;
		expect(next).toContain("Thing 249 ");
		expect(next).not.toContain("Thing 199 ");
		const json = treeJson(page(250), { maxRows: 10 }) as Extract<Node, { type: "page" }>;
		const table = json.children[0] as Extract<Node, { type: "table" }> & { paging?: unknown };
		expect(table.rows).toHaveLength(10);
		expect(table.paging).toEqual({ offset: 0, total: 250 });
	});
	test("an offset past the end says so instead of calling sections empty", () => {
		const text = treeText(page(13), { table: "things", offset: 50 }).text;
		expect(text).toContain("## Table things: 13 rows");
		expect(text).toContain("(offset 50 is past the end: the table has 13 rows; offsets start at 0)");
		expect(text).not.toContain("Empty sections");
		expect(text).not.toContain("Thing 0");
		// Paging part-way doesn't claim sections are empty either: rows before the offset weren't looked at.
		expect(treeText(page(13), { table: "things", offset: 5 }).text).not.toContain("Empty sections");
	});
	test("max_rows 0 gives each table's size and columns without rows", () => {
		const text = treeText(page(13), { maxRows: 0 }).text;
		expect(text).toContain("## Table things: 13 rows");
		expect(text).toContain("Columns: Name · Due");
		expect(text).toContain("(13 rows not listed: max_rows is 0)");
		expect(text).not.toContain("Thing 0");
		expect(text).not.toContain("Empty sections");
	});
	test("details: false leaves rows' details, stats and panes out of JSON too, at every depth", () => {
		const tree: Node = {
			type: "table",
			id: "t",
			columns: [{ key: "name", title: "Name" }],
			rows: [{
				id: "a",
				cells: { name: "Alpha" },
				details: [{ label: "Note", value: "secret plan" }],
				stats: [{ label: "CPU", value: "3%" }],
				pane: [{ type: "text", text: "pane body" }],
				children: [{ id: "a1", cells: { name: "Child" }, details: [{ label: "Note", value: "child note" }] }],
			}],
		};
		const lean = JSON.stringify(treeJson(tree, { details: false }));
		expect(lean).toContain('"Alpha"');
		expect(lean).toContain('"Child"');
		for (const gone of ["secret plan", "3%", "pane body", "child note"]) expect(lean).not.toContain(gone);
		expect(JSON.stringify(treeJson(tree))).toContain("child note");
	});
	test("JSON times get an ISO 8601 copy", () => {
		const at = Date.UTC(2026, 10, 25, 12);
		const json = JSON.stringify(treeJson(page(1)));
		expect(json).toContain(`"at":${at},"atIso":"2026-11-25T12:00:00.000Z"`);
	});
	test("multi-line values stay on their line and indentation", () => {
		const tree: Node = {
			type: "page",
			children: [
				{
					type: "table",
					id: "t",
					columns: [{ key: "cmd", title: "Command" }],
					rows: [{
						id: "a",
						cells: { cmd: "bash -c '\nexec \"$@\"' t3" },
						pane: [{ type: "timeline", id: "updates", entries: [{ id: "e", at: Date.UTC(2026, 10, 25), text: "first line\nsecond line" }] }],
					}],
				},
				{ type: "log", id: "log", lines: ["one\ntwo"] },
			],
		};
		const lines = treeText(tree).text.split("\n");
		expect(lines.find((l) => l.includes("bash -c"))).toContain("bash -c ' / exec \"$@\"' t3");
		expect(lines.find((l) => l.includes("first line"))).toMatch(/^ {4}- .*first line \/ second line$/);
		expect(lines).toContain("  one / two");
		// No line starts a value's continuation at column 0.
		expect(lines.some((l) => /^(second line|exec|two)/.test(l))).toBe(false);
	});
	test("headings leave out the plugin's internal ids and repeated section names", () => {
		const tree: Node = {
			type: "page",
			children: [
				{
					type: "table",
					id: "tasks",
					columns: [{ key: "name", title: "Name" }],
					sections: [{ id: "progressing", label: "Progressing", sections: [{ id: "doing", label: "Progressing" }, { id: "watching", label: "Watching" }] }],
					rows: [{ id: "a", group: "doing", cells: { name: "Alpha" }, pane: [{ type: "form", id: "task", fields: [{ type: "text", id: "desc", label: "", value: "the description" }, { type: "text", id: "who", label: "Owner", value: "Ann" }] }] }],
				},
				{ type: "timeline", id: "updates", entries: [] },
			],
		};
		const text = treeText(tree).text;
		// The table id stays: it is what `table` pages.
		expect(text).toContain("## Table tasks: 1 row");
		expect(text).toContain("### Progressing\n- Alpha");
		expect(text).not.toContain("Progressing › Progressing");
		expect(text).toContain("Empty sections: Progressing › Watching");
		expect(text).toContain("    Form\n");
		expect(text).toContain("    - the description");
		expect(text).toContain("    - Owner: Ann");
		expect(text).toContain("## Timeline: 0 entries");
		for (const id of ["Form task", "desc:", "Timeline updates"]) expect(text).not.toContain(id);
	});
	test("a row lists its own actions when it allows fewer, and details don't repeat its cells", () => {
		const tree: Node = {
			type: "table",
			id: "t",
			columns: [{ key: "name", title: "Name" }, { key: "cpu", title: "CPU" }],
			actions: [{ id: "archive", label: "Archive" }, { id: "unarchive", label: "Unarchive" }, { id: "read", label: "Mark read" }],
			rows: [
				{ id: "a", cells: { name: "Alpha", cpu: "3%" }, actions: ["archive", "read"], stats: [{ label: "CPU", value: "3%" }, { label: "Threads", value: "3%" }] },
				{ id: "b", cells: { name: "Beta", cpu: "1%" }, actions: ["archive", "unarchive", "read"] },
				{ id: "c", cells: { name: "Gamma", cpu: "0%" } },
			],
		};
		const text = treeText(tree).text;
		expect(text).toContain("Row actions: Archive, Unarchive, Mark read (a row that allows fewer lists its own)");
		expect(text).toContain("{id: a} (actions: Archive, Mark read)");
		expect(text).toMatch(/\{id: b\}\n/);
		expect(text).toMatch(/\{id: c\}$/);
		// The CPU stat repeats the CPU cell; Threads has the same value but is another fact.
		expect(text).not.toContain("CPU: 3%");
		expect(text).toContain("Threads: 3%");
	});
});

/** A host with plugins whose surfaces render a tree a moment after they open. */
function fakeHost(plugins: Manifest[], render: (plugin: string, surface: string) => Node | null = () => page(3)) {
	type L = Parameters<AgentHost["subscribe"]>[0];
	const listeners = new Set<L>();
	const trees = new Map<string, { tree: Node; at: number }>();
	const viewers = new Map<string, number>();
	const events: string[] = [];
	const infos: PluginInfo[] = plugins.map((m) => ({ manifest: m, state: "running", badge: null }));
	const host: AgentHost & { events: string[]; infos: PluginInfo[] } = {
		events,
		infos,
		list: () => infos,
		open(plugin, surface) {
			const key = `${plugin}\n${surface}`;
			viewers.set(key, (viewers.get(key) ?? 0) + 1);
			events.push(`open ${plugin} ${surface}`);
			setTimeout(() => {
				const tree = render(plugin, surface);
				if (!tree) return;
				trees.set(key, { tree, at: Date.now() });
				listeners.forEach((l) => l.tree(plugin, surface, tree));
			}, 10);
			return null;
		},
		close(plugin, surface) {
			const key = `${plugin}\n${surface}`;
			viewers.set(key, Math.max(0, (viewers.get(key) ?? 0) - 1));
			events.push(`close ${plugin} ${surface}`);
		},
		snapshot(plugin, surface) {
			const key = `${plugin}\n${surface}`;
			const t = trees.get(key);
			return { tree: t?.tree ?? null, at: t?.at ?? 0, viewers: viewers.get(key) ?? 0 };
		},
		subscribe(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
	};
	return host;
}

const tmp = () => mkdtempSync(join(tmpdir(), "tb-agent-"));

function makeCore(host: AgentHost, access: Record<string, "none" | "read" | "act"> = {}) {
	const dir = tmp();
	let settings = { enabled: true, access };
	const core = new AgentCore({
		host,
		settings: () => settings,
		save: (next) => (settings = next),
		app: () => ({ name: "ToolBelt", version: "9.9.9", channel: "test", developmentProfile: null }),
		installed: () => host.list().map((p) => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, enabled: true, declared: declaredAccess(p.manifest) })),
		auditFile: join(dir, "agent-audit.jsonl"),
		socket: join(dir, "agent.sock"),
		command: null,
		changed: () => {},
		holdMs: 80,
		renderWaitMs: 500,
	});
	return { core, dir, settings: () => settings };
}

describe("agent core", () => {
	test("hides plugins that opt out and refuses them like unknown ones", async () => {
		const host = fakeHost([manifest("tasks"), manifest("secret", { agent: { access: "none" } })]);
		const { core, dir } = makeCore(host);
		const session = core.openSession("test", "interactive");
		const status = await core.call(session, "toolbelt_status");
		expect(status.text).toContain("Tasks (tasks)");
		expect(status.text).not.toContain("Secret");
		expect(status.text).toContain("1 more plugin is not available to agents");
		const screens = await core.call(session, "list_screens");
		expect(screens.text).not.toContain("secret");
		const refused = await core.call(session, "read_screen", { plugin: "secret" });
		const unknown = await core.call(session, "read_screen", { plugin: "nope" });
		expect(refused.isError).toBe(true);
		expect(refused.text.replace("secret", "X")).toBe(unknown.text.replace("nope", "X"));
		expect((await core.call(session, "list_plugins")).text).not.toContain("secret");
		expect(host.events).toEqual([]);
		const audit = readFileSync(join(dir, "agent-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(audit.map((a) => `${a.operation}:${a.outcome}`)).toEqual(["toolbelt_status:ok", "list_screens:ok", "read_screen:denied", "read_screen:denied", "list_plugins:ok"]);
		expect(audit[0]).toMatchObject({ client: "test", mode: "interactive" });
	});

	test("an undeclared plugin is hidden until the person allows it, then readable", async () => {
		const legacy: Manifest = { ...manifest("legacy"), agent: undefined };
		const host = fakeHost([manifest("tasks"), legacy]);
		const { core, settings } = makeCore(host);
		const session = core.openSession("t", "interactive");
		expect((await core.call(session, "toolbelt_status")).text).toContain("1 more plugin is not available to agents");
		expect((await core.call(session, "read_screen", { plugin: "legacy" })).isError).toBe(true);
		expect(core.state().plugins.find((p) => p.id === "legacy")).toMatchObject({ declared: false, ceiling: "read", byDefault: "none", effective: "none" });
		core.handle({ operation: "setAccess", plugin: "legacy", access: "read" }, () => {});
		expect(settings().access).toEqual({ legacy: "read" });
		expect((await core.call(session, "read_screen", { plugin: "legacy" })).text).toContain("# Legacy › Main");
		expect((await core.call(session, "list_plugins")).text).toContain("Legacy (legacy)");
	});

	test("the person's choice lowers access", async () => {
		const host = fakeHost([manifest("tasks")]);
		const { core } = makeCore(host, { tasks: "none" });
		const session = core.openSession("t", "interactive");
		expect((await core.call(session, "read_screen", { plugin: "tasks" })).isError).toBe(true);
		expect(core.state().plugins[0]).toMatchObject({ ceiling: "read", choice: "none", effective: "none" });
	});

	test("reading opens the surface, waits for its render and releases it when idle", async () => {
		const host = fakeHost([manifest("tasks")]);
		const { core } = makeCore(host);
		const session = core.openSession("t", "interactive");
		const r = await core.call(session, "read_screen", { plugin: "tasks" });
		expect(r.isError).toBeUndefined();
		expect(r.text).toContain("# Tasks › Main");
		expect(r.text).toContain("Thing 2");
		expect(r.text).toContain('currently shows: filter "Kind" = Apples');
		expect(host.events).toEqual(["open tasks screen:main"]);
		await core.call(session, "read_screen", { plugin: "tasks", screen: "main" });
		expect(host.events).toEqual(["open tasks screen:main"]);
		await Bun.sleep(150);
		expect(host.events).toEqual(["open tasks screen:main", "close tasks screen:main"]);
		expect((await core.call(session, "read_screen", { plugin: "tasks", screen: "nope" })).text).toContain("has no screen");
	});

	test("a crashed plugin is reported as unavailable (an error, not a refusal), with no stale badge", async () => {
		const host = fakeHost([manifest("tasks")]);
		host.infos[0] = { ...host.infos[0], state: "crashed", badge: 34, error: "boom\nstack" };
		const { core, dir } = makeCore(host);
		const session = core.openSession("t", "interactive");
		const r = await core.call(session, "read_screen", { plugin: "tasks" });
		expect(r).toEqual({ text: "Tasks is crashed: boom. The person can restart it in ToolBelt.", isError: true, kind: "unavailable" });
		const status = await core.call(session, "toolbelt_status", { format: "json" });
		expect(status.text).not.toContain("34");
		expect((status.data as { plugins: { badge: unknown; state: string }[] }).plugins[0]).toMatchObject({ state: "crashed", badge: null });
		expect((await core.call(session, "toolbelt_status")).text).toContain("Tasks (tasks) 1.0.0: crashed (can't be read until the person restarts it)");
		expect((await core.call(session, "list_screens")).text).toContain('screen "main" (default) (unavailable: Tasks is crashed)');
		const audit = readFileSync(join(dir, "agent-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(audit[0]).toMatchObject({ operation: "read_screen", outcome: "error", detail: expect.stringContaining("crashed") });
	});

	test("ids match in any case or by title, and mistakes get suggestions only among visible plugins", async () => {
		const host = fakeHost([manifest("processes"), manifest("secret", { agent: { access: "none" } })]);
		const { core } = makeCore(host);
		const session = core.openSession("t", "interactive");
		expect((await core.call(session, "list_screens", { plugin: "Processes" })).text).toContain('plugin "processes", screen "main"');
		expect((await core.call(session, "read_screen", { plugin: "PROCESSES", screen: "Settings" })).text).toContain('# Processes › Settings (plugin "processes", screen "settings")');
		const typo = await core.call(session, "read_screen", { plugin: "proceses" });
		expect(typo).toMatchObject({ isError: true, kind: "refused", text: expect.stringContaining('Did you mean "processes"?') });
		expect((await core.call(session, "read_screen", { plugin: "secre" })).text).not.toContain("secret");
		const screen = await core.call(session, "read_screen", { plugin: "processes", screen: "setings" });
		expect(screen.text).toContain('Did you mean "settings"?');
		expect(screen.text).toContain("Its screens: main (Main), settings (Settings).");
	});

	test("paging names a table that exists; offset alone pages the only table", async () => {
		const twoTables: Node = { type: "stack", children: [{ type: "table", id: "a", columns: [{ key: "n", title: "N" }], rows: [{ id: "1", cells: { n: "one" } }] }, { type: "table", id: "b", columns: [{ key: "n", title: "N" }], rows: [] }] };
		const host = fakeHost([manifest("tasks"), manifest("pair")], (plugin) => (plugin === "pair" ? twoTables : page(30)));
		const { core } = makeCore(host);
		const session = core.openSession("t", "interactive");
		const unknown = await core.call(session, "read_screen", { plugin: "tasks", table: "nosuch", offset: 50 });
		expect(unknown).toMatchObject({ isError: true, kind: "refused", text: 'Tasks › Main has no table "nosuch". Its tables: things.' });
		const paged = await core.call(session, "read_screen", { plugin: "tasks", offset: 25 });
		expect(paged.text).toContain("Thing 25 ");
		expect(paged.text).not.toContain("Thing 24 ");
		expect((await core.call(session, "read_screen", { plugin: "pair", offset: 1 })).text).toBe("offset pages one table: pass table too. Tables on this screen: a, b.");
		expect((await core.call(session, "read_screen", { plugin: "tasks", max_rows: 0 })).text).toContain("(30 rows not listed: max_rows is 0)");
	});

	test("text results carry everything; format json returns the same facts as data", async () => {
		const host = fakeHost([manifest("tasks")]);
		const { core } = makeCore(host);
		const session = core.openSession("t", "interactive");
		const text = await core.call(session, "read_screen", { plugin: "tasks" });
		expect(text.data).toBeUndefined();
		expect(text.text).toMatch(/rendered (now|\d+m ago)/);
		const json = await core.call(session, "read_screen", { plugin: "tasks", format: "json" });
		expect(JSON.parse(json.text)).toEqual(json.data);
		expect(json.data).toMatchObject({ plugin: "tasks", screen: "main", rendered: true, personViewing: false, renderedAtIso: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), viewState: ['filter "Kind" = Apples'] });
		for (const tool of ["toolbelt_status", "list_screens", "search_screens", "list_plugins"]) {
			const args = tool === "search_screens" ? { query: "thing" } : {};
			expect((await core.call(session, tool, args)).data).toBeUndefined();
			const r = await core.call(session, tool, { ...args, format: "json" });
			expect(JSON.parse(r.text)).toEqual(r.data);
		}
	});

	test("search finds lines across screens", async () => {
		const host = fakeHost([manifest("tasks"), manifest("notes")], (plugin, surface) =>
			surface === "screen:main" ? page(3) : { type: "text", text: `${plugin} settings: dark mode on` },
		);
		const { core } = makeCore(host);
		const r = await core.call(core.openSession("t", "interactive"), "search_screens", { query: "DARK mode", format: "json" });
		const data = r.data as { matches: { line: string }[]; screensSearched: number; failed: unknown[] };
		expect(data.matches.map((m) => m.line)).toEqual(["tasks settings: dark mode on", "notes settings: dark mode on"]);
		expect(data).toMatchObject({ screensSearched: 4, failed: [] });
	});

	test("search reports screens it couldn't read instead of a clean 'nothing found'", async () => {
		const host = fakeHost([manifest("tasks"), manifest("notes")], (plugin, surface) => (plugin === "tasks" && surface === "screen:settings" ? null : page(1)));
		host.infos[1] = { ...host.infos[1], state: "crashed", error: "Protocol complexity limit" };
		const { core } = makeCore(host);
		const session = core.openSession("t", "interactive");
		const r = await core.call(session, "search_screens", { query: "update" });
		expect(r.text).not.toContain("Nothing on 4 screens");
		expect(r.text).toContain('Nothing on 1 screen mentions "update".');
		expect(r.text).toContain("3 screens couldn't be searched, so matches there are unknown:");
		expect(r.text).toContain("- Tasks › Settings: it hasn't rendered yet");
		expect(r.text).toContain("- Notes › Main: Notes is crashed: Protocol complexity limit.");
		const json = await core.call(session, "search_screens", { query: "update", plugin: "notes", format: "json" });
		expect(json.data).toMatchObject({ screensSearched: 0, matches: [], failed: [{ plugin: "notes", screen: "main" }, { plugin: "notes", screen: "settings" }] });
		expect(json.isError).toBeUndefined();
	});

	test("setAccess saves the choice and releases what the agent held", async () => {
		const host = fakeHost([manifest("tasks")]);
		const { core, settings } = makeCore(host);
		await core.call(core.openSession("t", "interactive"), "read_screen", { plugin: "tasks" });
		core.handle({ operation: "setAccess", plugin: "tasks", access: "none" }, () => {});
		expect(settings().access).toEqual({ tasks: "none" });
		expect(host.events.at(-1)).toBe("close tasks screen:main");
		core.handle({ operation: "setAccess", plugin: "tasks", access: null }, () => {});
		expect(settings().access).toEqual({});
	});
});

describe("agent socket", () => {
	let server: AgentServer | undefined;
	afterEach(() => server?.stop());

	async function client(path: string) {
		const lines: any[] = [];
		const decoder = new TextDecoder();
		let buffer = "";
		const socket = await Bun.connect({
			unix: path,
			socket: {
				data(_s, chunk) {
					buffer += decoder.decode(chunk);
					let i: number;
					while ((i = buffer.indexOf("\n")) >= 0) {
						lines.push(JSON.parse(buffer.slice(0, i)));
						buffer = buffer.slice(i + 1);
					}
				},
			},
		});
		const send = (m: unknown) => socket.write(JSON.stringify(m) + "\n");
		const reply = async (id: number) => {
			const end = Date.now() + 3000;
			while (Date.now() < end) {
				const m = lines.find((l) => l.id === id);
				if (m) return m;
				await Bun.sleep(10);
			}
			throw new Error(`no reply ${id}`);
		};
		return { socket, send, reply, lines };
	}

	test("speaks MCP after a hello line, only to this user", async () => {
		const host = fakeHost([manifest("tasks")]);
		const { core, dir } = makeCore(host);
		server = new AgentServer(core, join(dir, "agent.sock"));
		await server.start();
		expect(core.state().running).toBe(true);
		expect(statSync(server.path).mode & 0o777).toBe(0o600);
		const c = await client(server.path);
		c.send({ toolbelt: 1, client: "probe", mode: "autonomous" });
		c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" }, capabilities: {} } });
		const init = await c.reply(1);
		expect(init.result.protocolVersion).toBe("2025-06-18");
		expect(init.result.serverInfo.name).toBe("toolbelt");
		c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		const tools = (await c.reply(2)).result.tools;
		expect(tools.map((t: { name: string }) => t.name)).toEqual(["toolbelt_status", "list_screens", "read_screen", "search_screens", "list_plugins"]);
		expect(tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
		c.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_screen", arguments: { plugin: "tasks" } } });
		const read = (await c.reply(3)).result;
		expect(read.content[0].text).toContain("Thing 0");
		// Text results have no structuredContent: clients that prefer it would show no screen.
		expect(read.structuredContent).toBeUndefined();
		c.send({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "read_screen", arguments: { plugin: "tasks", format: "json" } } });
		const json = (await c.reply(31)).result;
		expect(json.structuredContent).toMatchObject({ plugin: "tasks", tree: { type: "page" } });
		expect(JSON.parse(json.content[0].text)).toEqual(json.structuredContent);
		c.send({ jsonrpc: "2.0", id: 4, method: "resources/list" });
		expect((await c.reply(4)).result.resources.map((r: { uri: string }) => r.uri)).toEqual(["toolbelt://screens/tasks/main", "toolbelt://screens/tasks/settings"]);
		c.send({ jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "toolbelt://screens/tasks/main" } });
		expect((await c.reply(5)).result.contents[0].text).toContain("Thing 1");
		c.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
		expect((await c.reply(6)).error.code).toBe(-32602);
		c.send({ jsonrpc: "2.0", id: 7, method: "nope" });
		expect((await c.reply(7)).error.code).toBe(-32601);
		expect(core.state().sessions).toMatchObject([{ client: "claude-code", mode: "autonomous" }]);
		c.socket.end();
		await Bun.sleep(50);
		expect(core.state().sessions).toEqual([]);
		const audit = readFileSync(join(dir, "agent-audit.jsonl"), "utf8");
		expect(audit).toContain('"client":"claude-code","mode":"autonomous","operation":"read_screen"');
	});

	test("a crashed plugin's screens leave resources/list, and reading one is a server error, not 'not found'", async () => {
		const host = fakeHost([manifest("tasks"), manifest("notes")]);
		host.infos[1] = { ...host.infos[1], state: "crashed", error: "boom" };
		const { core, dir } = makeCore(host);
		server = new AgentServer(core, join(dir, "agent.sock"));
		await server.start();
		const c = await client(server.path);
		c.send({ toolbelt: 1, client: "probe" });
		c.send({ jsonrpc: "2.0", id: 1, method: "resources/list" });
		expect((await c.reply(1)).result.resources.map((r: { uri: string }) => r.uri)).toEqual(["toolbelt://screens/tasks/main", "toolbelt://screens/tasks/settings"]);
		c.send({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "toolbelt://screens/notes/main" } });
		expect((await c.reply(2)).error).toEqual({ code: -32603, message: "Notes is crashed: boom. The person can restart it in ToolBelt." });
		c.send({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "toolbelt://screens/nope/main" } });
		expect((await c.reply(3)).error.code).toBe(-32002);
		c.socket.end();
	});

	test("refuses a connection without a hello and replaces a stale socket file", async () => {
		const host = fakeHost([manifest("tasks")]);
		const { core, dir } = makeCore(host);
		const path = join(dir, "agent.sock");
		await Bun.write(path, "stale");
		server = new AgentServer(core, path);
		await server.start();
		expect(server.listening).toBe(true);
		const c = await client(path);
		c.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
		await Bun.sleep(50);
		expect(c.lines).toEqual([]);
		expect(core.state().sessions).toEqual([]);
		// A second server on the same path refuses rather than stealing it.
		const other = new AgentServer(makeCore(host).core, path);
		await other.start();
		expect(other.listening).toBe(false);
	});

	test("the CLI reads through the socket; the factory starts only when enabled", { timeout: 20_000 }, async () => {
		const host = fakeHost([manifest("tasks")]);
		const dir = tmp();
		let settings = { enabled: false, access: {} as Record<string, "none" | "read" | "act"> };
		const agents = createAgentInterface({
			host,
			settings: () => settings,
			save: (next) => (settings = next),
			app: () => ({ name: "ToolBelt", version: "9.9.9", channel: "test", developmentProfile: null }),
			configRoot: dir,
			profileRoot: dir,
			bun: process.execPath,
			cliScript: join(import.meta.dir, "../src/cli/toolbelt.ts"),
			changed: () => {},
		});
		await agents.start();
		expect(agents.server.listening).toBe(false);
		const state = agents.handle({ operation: "setEnabled", enabled: true }) as { command: string[] };
		expect(settings.enabled).toBe(true);
		expect(state.command.slice(-2)).toEqual(["--socket", join(dir, "agent.sock")]);
		await Bun.sleep(50);
		expect(agents.server.listening).toBe(true);
		// Async: the server runs in this process.
		const cli = async (...args: string[]) => {
			const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/toolbelt.ts"), "--socket", join(dir, "agent.sock"), ...args], { stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
			return { code, out, err };
		};
		const status = await cli("status");
		expect(status.code).toBe(0);
		expect(status.out).toContain("Tasks (tasks) 1.0.0: running");
		const read = await cli("read", "tasks", "main", "--max-rows", "1", "--no-details");
		expect(read.out).toContain("Thing 0");
		expect(read.out).not.toContain("note 0");
		expect(read.out).toContain('offset 1 for more');
		expect(JSON.parse((await cli("screens", "--json")).out).screens).toHaveLength(2);
		expect((await cli("read", "nope")).code).toBe(2);
		// Mistakes in the command line are refused, not ignored.
		const bogus = await cli("read", "tasks", "--bogus");
		expect(bogus).toMatchObject({ code: 2, out: "" });
		expect(bogus.err).toContain("Unknown option for toolbelt read: --bogus");
		expect((await cli("status", "--max-rows", "3")).code).toBe(2);
		expect((await cli("read", "tasks", "--table")).err).toContain("--table needs a value");
		expect(JSON.parse((await cli("read", "tasks", "--json")).out)).toMatchObject({ plugin: "tasks", tree: { type: "page" } });
		expect((await cli("skill")).out).toContain("name: toolbelt");
		agents.stop();
		const off = await cli("status");
		expect(off.code).toBe(1);
		expect(off.err).toContain("Settings → Agents");
		server = undefined;
	});
});

describe("Settings → Agents commands", () => {
	test("each agent gets add and remove commands; removing doesn't need ToolBelt", async () => {
		const { connectCommands } = await import("../src/ui/lib/agent-commands");
		const command = ["/Applications/Tool Belt.app/bun", "/app/cli/toolbelt.js", "--socket", "/x/agent.sock"];
		const byTitle = Object.fromEntries(connectCommands(command).map((c) => [c.title, Object.fromEntries(c.tabs.map((t) => [t.id, t.text]))]));
		expect(byTitle["Claude Code"].add).toBe("claude mcp add --scope user toolbelt -- '/Applications/Tool Belt.app/bun' /app/cli/toolbelt.js --socket /x/agent.sock mcp");
		expect(byTitle["Claude Code"].remove).toBe("claude mcp remove --scope user toolbelt");
		expect(byTitle.Codex).toEqual({ add: "codex mcp add toolbelt -- '/Applications/Tool Belt.app/bun' /app/cli/toolbelt.js --socket /x/agent.sock mcp", remove: "codex mcp remove toolbelt" });
		expect(JSON.parse(byTitle["Claude Desktop and other MCP clients"].json).mcpServers.toolbelt).toEqual({ command: command[0], args: [...command.slice(1), "mcp"] });
		for (const c of connectCommands(command)) if (c.tabs.some((t) => t.id === "remove")) expect(c.tabs.find((t) => t.id === "remove")!.text).not.toContain("toolbelt.js");
	});
});

describe("audit log", () => {
	const entry = (i: number) => ({
		at: 1_000_000 + i * 1000,
		session: "s",
		client: i % 3 === 0 ? "claude-code" : "codex",
		mode: (i % 5 === 0 ? "autonomous" : "interactive") as "autonomous" | "interactive",
		operation: i % 2 ? "read_screen" : "search_screens",
		plugin: i % 4 === 0 ? "tasks" : "updates",
		outcome: (i % 7 === 0 ? "denied" : i % 11 === 0 ? "error" : "ok") as "ok" | "denied" | "error",
		detail: `entry ${i} tag${i}z ${"x".repeat(150)}`,
	});
	function log(n: number, budget?: number) {
		const l = new AuditLog(join(tmp(), "agent-audit.jsonl"), budget);
		for (let i = 0; i < n; i++) l.append(entry(i));
		return l;
	}

	test("pages newest first across chunk boundaries, each entry once", () => {
		const l = log(3000); // ~600 KB: several 256 KB chunks
		const seen: number[] = [];
		let next: number | null | undefined;
		do {
			const page = l.query({ limit: 400, before: next ?? undefined });
			seen.push(...page.entries.map((e) => Number(e.detail!.split(" ")[1])));
			next = page.next;
		} while (next !== null);
		expect(seen).toEqual(Array.from({ length: 3000 }, (_, i) => 2999 - i));
	});

	test("filters by words, plugin, result, mode and time, and fetches what's newer", () => {
		const l = log(300);
		const page = l.query({ limit: 500, filter: { plugins: ["tasks"], outcomes: ["denied"], modes: ["interactive"], since: 1_000_000 + 100_000 } });
		expect(page.entries.length).toBeGreaterThan(0);
		expect(page.entries.every((e) => e.plugin === "tasks" && e.outcome === "denied" && e.mode === "interactive" && e.at >= 1_100_000)).toBe(true);
		// Labels match too: "Read a screen" is read_screen.
		expect(l.query({ limit: 500, filter: { query: "READ a screen claude" } }).entries.every((e) => e.operation === "read_screen" && e.client === "claude-code")).toBe(true);
		const top = l.query({ limit: 1 }).entries[0];
		l.append(entry(300));
		l.append(entry(301));
		const newer = l.query({ after: top.id });
		expect(newer.entries.map((e) => e.detail!.split(" ")[1])).toEqual(["301", "300"]);
		expect(newer.next).toBeNull();
		expect(l.query({ after: newer.entries[0].id }).entries).toEqual([]);
	});

	test("a list matches any of its values", () => {
		const l = log(100);
		const both = l.query({ limit: 500, filter: { outcomes: ["denied", "error"] } }).entries;
		expect(new Set(both.map((e) => e.outcome))).toEqual(new Set(["denied", "error"]));
		expect(l.query({ limit: 500, filter: { plugins: ["tasks", "updates"] } }).entries).toHaveLength(100);
	});

	test("a past time range is found without scanning the whole log, and is exact", () => {
		// Entries every second; the range is 20 seconds a third of the way into a ~600 KB log.
		const l = log(3000, 300 * 1024);
		const since = 1_000_000 + 1000 * 1000;
		const until = since + 19_000;
		const page = l.query({ limit: 100, filter: { since, until } });
		expect(page.entries.map((e) => e.at)).toEqual(Array.from({ length: 20 }, (_, i) => until - i * 1000));
		// Past the start it stops: no cursor into older entries.
		expect(page.next).toBeNull();
		// Pages within the range continue from the cursor.
		const first = l.query({ limit: 8, filter: { since, until } });
		const second = l.query({ limit: 100, before: first.next!, filter: { since, until } });
		expect([...first.entries, ...second.entries].map((e) => e.at)).toEqual(page.entries.map((e) => e.at));
	});

	test("a search stops at its scan budget and continues from the cursor", () => {
		const l = log(3000, 300 * 1024);
		const rare = { query: "tag5z" };
		const first = l.query({ limit: 10, filter: rare });
		expect(first.entries).toEqual([]);
		expect(first.next).not.toBeNull();
		let next = first.next;
		let found: string[] = [];
		while (next !== null && !found.length) {
			const page = l.query({ limit: 10, before: next, filter: rare });
			found = page.entries.map((e) => e.detail!.split(" ")[1]);
			next = page.next;
		}
		expect(found).toEqual(["5"]);
	});

	test("a missing log is an empty page", () => {
		expect(new AuditLog(join(tmp(), "none.jsonl")).query()).toEqual({ entries: [], next: null });
	});
});

describe("Activity time ranges", () => {
	test("bounds and labels", async () => {
		const { rangeBounds, rangeLabel, localTime } = await import("../src/ui/lib/time-range");
		const now = new Date(2026, 10, 25, 15, 30).getTime();
		expect(rangeBounds({ preset: "1h" }, now)).toEqual({ since: now - 3_600_000 });
		expect(rangeBounds({ preset: "today" }, now)).toEqual({ since: new Date(2026, 10, 25).getTime() });
		expect(rangeBounds({ preset: "yesterday" }, now)).toEqual({ since: new Date(2026, 10, 24).getTime(), until: new Date(2026, 10, 25).getTime() - 1 });
		// A date alone covers the whole day; a time covers its whole minute.
		expect(rangeBounds({ from: "2026-11-20", to: "2026-11-20" })).toEqual({ since: new Date(2026, 10, 20).getTime(), until: new Date(2026, 10, 21).getTime() - 1 });
		expect(rangeBounds({ from: "2026-11-20T09:00", to: "" })).toEqual({ since: new Date(2026, 10, 20, 9).getTime(), until: undefined });
		expect(localTime("2026-11-20T11:00", true)).toBe(new Date(2026, 10, 20, 11, 1).getTime() - 1);
		expect(rangeLabel(null)).toBeNull();
		expect(rangeLabel({ preset: "7d" })).toBe("Last 7 days");
		expect(rangeLabel({ from: "2026-11-20T09:00", to: "2026-11-20T11:00" })).toMatch(/^Nov 20, .*9.*00.* – .*11.*00/);
		expect(rangeLabel({ from: "2026-11-20", to: "" })).toBe("Since Nov 20");
	});
});
