// The agent interface (docs/agent-interface.md): access levels, the serializer, the core against a fake
// host, and the MCP socket and CLI end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSettings, ceilingOf, declaredAccess, defaultAccess, effectiveAccess } from "../src/shared/agents";
import { parseManifest, type Manifest, type Node } from "../src/shared/protocol";
import type { PluginInfo } from "../src/shared/plugin-state";
import { MASK, maskSecrets, redact, treeJson, treeText } from "../src/bun/agent/serialize";
import { AgentCore, type AgentHost } from "../src/bun/agent/core";
import { AgentServer } from "../src/bun/agent/server";
import { AuditLog } from "../src/bun/agent/audit";
import { commandWarning, createAgentInterface } from "../src/bun/agent";
import { bundledSettingsFolder } from "../src/shared/variant";

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
	test("masks likely secrets in any plugin text, keeping what isn't one", () => {
		// Fake secrets are assembled at run time, so the repository's secret scan (gitleaks) doesn't flag this file.
		const fake = (...parts: string[]) => parts.join("");
		const cases: [string, string][] = [
			["node server.js --token=abc123 --port 3000", `node server.js --token=${MASK} --port 3000`],
			[fake("claude --api-key sk-ant-", "api03-", "A".repeat(24), " --resume 1234"), `claude --api-key ${MASK} --resume 1234`],
			[fake("GITHUB_TOKEN=gh", "p_", "abcdefghijklmnopqrstuvwxyz0123 gh pr list"), `GITHUB_TOKEN=${MASK} gh pr list`],
			[fake("curl -H 'Author", "ization: Bea", "rer abc.def.ghi' https://u:hunter2@example.com/x?page=1&access_token=zzz&b=2"), `curl -H 'Authorization: Bearer ${MASK}' https://u:${MASK}@example.com/x?page=1&access_token=${MASK}&b=2`],
			["psql postgres://app:s3cret@localhost/db", `psql postgres://app:${MASK}@localhost/db`],
			[fake("export AWS_SECRET_ACCESS_KEY=", "wJalrXUtn", "FEMI/K7MDENG"), `export AWS_SECRET_ACCESS_KEY=${MASK}`],
			['{"api_key": "abcd", "name": "x"}', `{"api_key": "${MASK}", "name": "x"}`],
			["password: hunter2", `password: ${MASK}`],
			[fake("key AKIA", "IOSFODNN7EXAMPLE in use"), `key ${MASK} in use`],
			// Not secrets: flags without a value, ids, settings blobs, counts and prose.
			["claude --settings '{\"permissions\":{\"allow\":[\"Bash\"]}}' --allow-dangerously-skip-permissions --session-id 1e2f", "claude --settings '{\"permissions\":{\"allow\":[\"Bash\"]}}' --allow-dangerously-skip-permissions --session-id 1e2f"],
			["--no-token-cache --verbose", "--no-token-cache --verbose"],
			["Tokens: 1200", "Tokens: 1200"],
			["Rotate your API key in Settings", "Rotate your API key in Settings"],
		];
		for (const [input, masked] of cases) expect(maskSecrets(input)).toBe(masked);
		// Applied everywhere: cells, details and JSON alike.
		const tree: Node = { type: "table", id: "p", columns: [{ key: "cmd", title: "Command" }], rows: [{ id: "1", cells: { cmd: "app --password=pw1" }, details: [{ label: "Resume with", value: "GH_TOKEN=xyz app" }] }] };
		expect(treeText(tree).text).not.toMatch(/pw1|xyz/);
		expect(JSON.stringify(treeJson(tree))).not.toMatch(/pw1|xyz/);
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
		expect(first).toContain("Thing 49 ");
		expect(first).not.toContain("Thing 50 ");
		expect(first).toContain('(showing rows 1–50 of 250; read again with table "things" and offset 50 for more)');
		const next = treeText(page(250), { table: "things", offset: 200, maxRows: 100 }).text;
		expect(next).toContain("Thing 249 ");
		expect(next).not.toContain("Thing 199 ");
		const json = treeJson(page(250), { maxRows: 10 }) as Extract<Node, { type: "page" }>;
		const table = json.children[0] as Extract<Node, { type: "table" }> & { paging?: unknown };
		expect(table.rows).toHaveLength(10);
		expect(table.paging).toEqual({ offset: 0, total: 250, next: 10 });
	});
	test("max_rows counts child rows; top-level rows stay whole except a first one that can't fit", () => {
		const tree = (children: number, rows = 3): Node => ({
			type: "table",
			id: "procs",
			columns: [{ key: "name", title: "Name" }],
			rows: Array.from({ length: rows }, (_, i) => ({
				id: `p${i}`,
				cells: { name: `Parent ${i}` },
				children: Array.from({ length: children }, (_, j) => ({ id: `p${i}c${j}`, cells: { name: `Child ${i}.${j}` } })),
			})),
		});
		// One process tree bigger than the page: the parent and as many children as fit.
		const big = treeText(tree(48), { maxRows: 5 }).text;
		expect(big.match(/\{id: /g)).toHaveLength(5);
		expect(big).toContain("Child 0.3");
		expect(big).not.toContain("Child 0.4");
		expect(big).toContain("## Table procs: 3 rows (147 with nested rows)");
		expect(big).toContain('  (44 more rows under this one not listed; read again with table "procs", parent "p0" and offset 4 to page them)');
		expect(big).toContain('(showing rows 1–1 of 3 (offsets count top-level rows; max_rows counts nested rows too); read again with table "procs" and offset 1 for more)');
		// Smaller trees come whole: two of four rows each fit in 10.
		const whole = treeText(tree(3), { maxRows: 10 }).text;
		expect(whole).toContain("Child 1.2");
		expect(whole).not.toContain("Parent 2");
		expect(whole).not.toContain("more rows under");
		expect(whole).toContain("offset 2 for more");
		const json = treeJson(tree(48), { maxRows: 5 }) as Extract<Node, { type: "table" }> & { paging: unknown };
		expect(json.rows).toHaveLength(1);
		expect(json.rows[0]).toMatchObject({ omittedChildren: 44 });
		expect(json.rows[0].children).toHaveLength(4);
		expect(json.paging).toEqual({ offset: 0, total: 3, next: 1 });
	});
	test("a result over its size budget stops at a row boundary, names where to resume, and loses no table", () => {
		const big: Node = {
			type: "page",
			children: [
				{ type: "table", id: "procs", columns: [{ key: "name", title: "Name" }], rows: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, cells: { name: `Proc ${i}` }, details: [{ label: "Command", value: `/usr/bin/thing --flag ${"x".repeat(400)} end${i}` }] })) },
				{ type: "table", id: "kept", columns: [{ key: "name", title: "Name" }], rows: [{ id: "k", cells: { name: "Kept one" }, details: [{ label: "Note", value: "z".repeat(1000) }] }] },
			],
		};
		const { text } = treeText(big, { budget: 4000 });
		expect(text.length).toBeLessThan(4600);
		const stop = text.match(/\(showing rows 1–(\d+) of 40: the result reached its size limit; read again with table "procs" and offset (\d+), or pass details: false for shorter rows\)/);
		expect(stop).not.toBeNull();
		expect(stop![1]).toBe(stop![2]);
		const last = Number(stop![2]) - 1;
		// The last row shown is complete, details and all; the next one is absent.
		expect(text).toContain(`end${last}`);
		expect(text).not.toContain(`Proc ${last + 1} `);
		// A later table is still announced, with how to read it.
		expect(text).toContain("## Table kept: 1 row");
		expect(text).toContain('(1 row not listed: the result reached its size limit; read again with table "kept" and offset 0)');
		// Resuming continues where it stopped.
		expect(treeText(big, { budget: 4000, table: "procs", offset: last + 1 }).text).toContain(`Proc ${last + 1} `);
	});
	test("content outside tables is cut at a line boundary, saying where", () => {
		const tree: Node = { type: "markdown", text: Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n") };
		const { text } = treeText(tree, { budget: 2000 });
		expect(text.length).toBeLessThan(2200);
		const lines = text.split("\n");
		expect(lines.at(-1)).toMatch(/^\(truncated after line \d+ of \d+ at the result's size limit; read one table at a time with table and offset, or pass details: false\)$/);
		expect(lines.slice(0, -1).every((l) => /^line \d+ y{30}$/.test(l))).toBe(true);
	});
	test("JSON is cut to its size budget at row boundaries, with where to resume", () => {
		const tree = page(500);
		const json = treeJson(tree, { maxRows: 500, budget: 20_000 }) as Extract<Node, { type: "page" }>;
		expect(JSON.stringify(json).length).toBeLessThanOrEqual(20_000);
		const table = json.children[0] as Extract<Node, { type: "table" }> & { paging: { offset: number; total: number; next: number; reason: string } };
		expect(table.rows.length).toBeGreaterThan(10);
		expect(table.paging).toEqual({ offset: 0, total: 500, next: table.rows.length, reason: "size" });
		expect(table.rows.at(-1)!.id).toBe(`t${table.rows.length - 1}`);
		// The form after the table is kept whole.
		expect(JSON.stringify(json.children[1])).toContain('"Secrets"');
	});
	test("JSON leaves out visual-only fields but never plugin data named like them", () => {
		const tree: Node = {
			type: "table",
			id: "t",
			columns: [{ key: "icon", title: "Icon", width: 40 }, { key: "width", title: "Width" }],
			actions: [{ id: "open", label: "Open", icon: "external-link", key: "o" }],
			rows: [{ id: "a", cells: { icon: "🙂", width: { text: "12 cm", strong: "12" } } }],
		};
		const json = JSON.stringify(treeJson(tree));
		expect(json).not.toContain("external-link");
		expect(json).not.toContain('"width":40');
		expect(json).not.toContain('"strong"');
		expect(json).toContain('"cells":{"icon":"🙂","width":{"text":"12 cm"}}');
		expect(json).toContain('"label":"Open"');
	});
	test("an offset past the end says so instead of calling sections empty", () => {
		const text = treeText(page(13), { table: "things", offset: 50 }).text;
		expect(text).toContain("## Table things: 13 rows");
		expect(text).toContain("(offset 50 is past the end: there are 13 rows; offsets start at 0)");
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
				{ type: "log", id: "log", lines: [{ text: "one\ntwo" }] },
			],
		};
		const lines = treeText(tree).text.split("\n");
		// " ⏎ ", not "/": commands and paths are full of slashes.
		expect(lines.find((l) => l.includes("bash -c"))).toContain("bash -c ' ⏎ exec \"$@\"' t3");
		expect(lines.find((l) => l.includes("first line"))).toMatch(/^ {4}- .*first line ⏎ second line$/);
		expect(lines).toContain("  one ⏎ two");
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
		// An untitled form gets no heading.
		expect(text).toContain("{id: a}\n    - the description\n    - Owner: Ann");
		expect(text).toContain("    - Owner: Ann");
		expect(text).toContain("## Timeline: 0 entries");
		for (const id of ["Form task", "desc:", "Timeline updates"]) expect(text).not.toContain(id);
	});
	test("a field with neither label nor value, and a count beside an empty message, are left out", () => {
		const tree: Node = {
			type: "stack",
			children: [
				{ type: "form", id: "task", fields: [{ type: "text", id: "desc", label: "", value: "" }, { type: "text", id: "notes", label: "Notes", value: "" }] },
				{ type: "timeline", id: "updates", entries: [], empty: { title: "No updates yet" } },
				{ type: "list", id: "l", items: [], empty: { title: "Nothing here" } },
			],
		};
		const text = treeText(tree).text;
		expect(text).toBe("- Notes: \n\n## Timeline\n(empty: No updates yet)\n\n## List\n(empty: Nothing here)");
	});
	test("a long value already on the row line, or on the parent's, isn't repeated in details", () => {
		const cmd = "/Applications/T3 Code.app/Contents/MacOS/T3 Code --type=renderer --lang=en-US";
		const tree: Node = {
			type: "table",
			id: "procs",
			columns: [{ key: "name", title: "Process" }],
			rows: [{
				id: "p",
				cells: { name: cmd },
				details: [{ label: "Command", value: cmd }, { label: "PID", value: "41" }],
				children: [
					{ id: "c", cells: { name: "helper" }, details: [{ section: "Process", label: "Part of", value: cmd }, { label: "PID", value: "41" }] },
				],
			}],
		};
		const text = treeText(tree).text;
		expect(text.split(cmd).length - 1).toBe(1);
		// Short values are kept even when they match: "41" may be a different fact.
		expect(text.match(/PID: 41/g)).toHaveLength(2);
	});
	test("parent pages one row's children, in text and JSON", () => {
		const tree: Node = {
			type: "table",
			id: "procs",
			columns: [{ key: "name", title: "Name" }],
			rows: [
				{ id: "a", cells: { name: "Alpha" } },
				{ id: "b", cells: { name: "Beta" }, children: [{ id: "b1", cells: { name: "Beta child" }, children: Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, cells: { name: `Grandchild ${i}` } })) }] },
			],
		};
		const text = treeText(tree, { table: "procs", parent: "b1", offset: 10, maxRows: 5 }).text;
		expect(text).toContain("## Table procs, rows under b1: 30 rows");
		expect(text).toContain("Grandchild 10 ");
		expect(text).toContain("Grandchild 14 ");
		expect(text).not.toContain("Grandchild 15 ");
		expect(text).not.toContain("Alpha");
		expect(text).toContain('(showing rows 11–15 of 30; read again with table "procs", parent "b1" and offset 15 for more)');
		const json = treeJson(tree, { table: "procs", parent: "b1", offset: 28 }) as Extract<Node, { type: "table" }> & { paging: unknown };
		expect(json.rows.map((r) => r.id)).toEqual(["g28", "g29"]);
		expect(json.paging).toEqual({ offset: 28, total: 30, next: null, parent: "b1" });
	});
	test("a resource read's hints name the URI to read next", () => {
		const text = treeText(page(80), { resource: "toolbelt://screens/desk/tasks", budget: 3000 }).text;
		expect(text).toMatch(/read toolbelt:\/\/screens\/desk\/tasks\?table=things&offset=\d+, or add details=false for shorter rows\)/);
		expect(text).not.toContain("read again with table");
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
function fakeHost(plugins: Manifest[], render: (plugin: string, surface: string) => Node | { rejected: string } | null = () => page(3)) {
	type L = Parameters<AgentHost["subscribe"]>[0];
	const listeners = new Set<L>();
	const trees = new Map<string, { tree: Node; at: number }>();
	const errors = new Map<string, string>();
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
				// A rejected render: the host shows its error tree, and snapshots report the reason.
				if ("rejected" in tree) {
					errors.set(key, tree.rejected);
					listeners.forEach((l) => l.tree(plugin, surface, { type: "empty", title: "This screen couldn't be shown" }));
					return;
				}
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
			return { tree: t?.tree ?? null, at: t?.at ?? 0, viewers: viewers.get(key) ?? 0, ...(errors.has(key) ? { error: errors.get(key) } : {}) };
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

	test("a screen whose render the host rejected is unavailable; the plugin's other screens still read", async () => {
		const host = fakeHost([manifest("upkeep")], (_p, surface) => (surface === "screen:main" ? { rejected: "Protocol complexity limit: more than 50000 values" } : page(1)));
		const { core, dir } = makeCore(host);
		const session = core.openSession("t", "interactive");
		const r = await core.call(session, "read_screen", { plugin: "upkeep" });
		expect(r).toEqual({ isError: true, kind: "unavailable", text: "Upkeep › Main couldn't be shown: Protocol complexity limit: more than 50000 values" });
		expect((await core.call(session, "read_screen", { plugin: "upkeep", screen: "settings" })).text).toContain("Thing 0");
		const search = await core.call(session, "search_screens", { query: "thing" });
		expect(search.text).toContain("- Upkeep › Main: Upkeep › Main couldn't be shown");
		const audit = readFileSync(join(dir, "agent-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(audit[0]).toMatchObject({ operation: "read_screen", outcome: "error" });
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
		expect(await core.call(session, "read_screen", { plugin: "tasks", parent: "nope" })).toMatchObject({ isError: true, kind: "refused", text: 'Table "things" has no row "nope". Row ids are shown as {id: …}.' });
		expect((await core.call(session, "read_screen", { plugin: "tasks", parent: "t3" })).text).toContain("## Table things, rows under t3: 0 rows");
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

	test("search groups a row's matches into one hit and shortens long lines", async () => {
		const command = `/usr/local/bin/node ${"--max-old-space-size=4096 ".repeat(12)}server.js --port 3000`;
		const procs: Node = {
			type: "table",
			id: "procs",
			columns: [{ key: "name", title: "Name" }, { key: "cmd", title: "Command" }],
			rows: [
				{ id: "1", cells: { name: "node", cmd: command }, details: [{ label: "Command", value: command }, { label: "Resume with", value: `cd ~/app && ${command}` }] },
				{ id: "2", cells: { name: "postgres", cmd: "postgres -D /data" }, details: [{ label: "Port", value: "5432" }] },
			],
		};
		const host = fakeHost([manifest("processes")], (_p, surface) => (surface === "screen:main" ? procs : { type: "text", text: "nothing" }));
		const { core } = makeCore(host);
		const session = core.openSession("t", "interactive");
		const r = await core.call(session, "search_screens", { query: "server.js", format: "json" });
		const data = r.data as { matches: { line: string; matched: string[]; section: string }[] };
		// One hit for the row, though its line and two details all mention server.js.
		expect(data.matches).toHaveLength(1);
		const hit = data.matches[0];
		expect(hit.section).toBe("Table procs: 2 rows");
		expect(hit.line.length).toBeLessThanOrEqual(300);
		expect(hit.line).toStartWith("node · /usr/local/bin/node");
		expect(hit.line).toEndWith("{id: 1}");
		// The detail that matched comes along, shortened, plus the part of the lines around the match;
		// the Command detail repeats the Command cell, so it isn't listed.
		expect(hit.matched.length).toBeGreaterThanOrEqual(2);
		expect(hit.matched.every((m) => m.length <= 300)).toBe(true);
		expect(hit.matched.some((m) => m.includes("server.js --port 3000"))).toBe(true);
		const text = (await core.call(session, "search_screens", { query: "server.js" })).text;
		expect(text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
		expect(text).toContain("    ↳ Resume with: cd ~/app && /usr/local/bin/node");
		expect(text).not.toContain("↳ Command:");
		// A match only in a detail still names its row.
		const port = (await core.call(session, "search_screens", { query: "5432" })).text;
		expect(port).toBe("- Processes › Main › Table procs: 2 rows: postgres · postgres -D /data  {id: 2}\n    ↳ Port: 5432");
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

	test("short connections in one group continue one session; concurrent ones get their own", () => {
		const { core } = makeCore(fakeHost([manifest("tasks")]));
		const a = core.openSession("toolbelt-cli", "interactive", "ppid:42");
		core.closeSession(a);
		const b = core.openSession("toolbelt-cli", "interactive", "ppid:42");
		expect(b.id).toBe(a.id);
		const parallel = core.openSession("toolbelt-cli", "interactive", "ppid:42");
		expect(parallel.id).not.toBe(b.id);
		expect(core.state().sessions).toHaveLength(2);
		core.closeSession(b);
		core.closeSession(parallel);
		expect(core.state().sessions).toEqual([]);
		for (const other of [core.openSession("toolbelt-cli", "interactive", "ppid:7"), core.openSession("toolbelt-cli", "autonomous", "ppid:42"), core.openSession("toolbelt-cli", "interactive")])
			expect([a.id, parallel.id]).not.toContain(other.id);
	});

	test("status shows plugin updates; list_plugins uses the same words for state and access", async () => {
		const host = fakeHost([manifest("tasks"), manifest("notes")]);
		host.infos[1] = { ...host.infos[1], state: "crashed" };
		const dir = tmp();
		const core = new AgentCore({
			host,
			settings: () => ({ enabled: true, access: {} }),
			save: () => {},
			app: () => ({ name: "ToolBelt Dev", version: "9.9.9", channel: "dev", developmentProfile: null, location: "/w/a/build.noindex/Toolbelt-dev.app" }),
			installed: () => [
				{ id: "tasks", name: "Tasks", version: "1.0.0", repo: "me/tasks", enabled: true, phase: "ready", availableVersion: "1.1.0", declared: "read" },
				{ id: "notes", name: "Notes", version: "1.0.0", enabled: true, phase: "ready", declared: "read" },
				{ id: "old", name: "Old", version: "0.1.0", enabled: false, declared: "read" },
			],
			auditFile: join(dir, "a.jsonl"),
			socket: join(dir, "s"),
			command: null,
			changed: () => {},
		});
		const session = core.openSession("t", "interactive");
		const status = await core.call(session, "toolbelt_status");
		expect(status.text).toContain("- Tasks (tasks) 1.0.0: running; update available: 1.1.0. Screens:");
		// Which build answers: two builds of one version are told apart by where they run from.
		expect(status.text).toStartWith(`ToolBelt Dev 9.9.9 (dev), answering from /w/a/build.noindex/Toolbelt-dev.app (process ${process.pid})`);
		expect(((await core.call(session, "toolbelt_status", { format: "json" })).data as { app: unknown }).app).toMatchObject({ location: "/w/a/build.noindex/Toolbelt-dev.app", pid: process.pid });
		expect(((await core.call(session, "toolbelt_status", { format: "json" })).data as { plugins: unknown[] }).plugins[0]).toMatchObject({ id: "tasks", state: "running", access: "read", availableVersion: "1.1.0" });
		const plugins = await core.call(session, "list_plugins", { format: "json" });
		expect((plugins.data as { plugins: unknown[] }).plugins).toEqual([
			{ id: "tasks", name: "Tasks", version: "1.0.0", state: "running", enabled: true, access: "read", availableVersion: "1.1.0", repo: "me/tasks", channel: null },
			{ id: "notes", name: "Notes", version: "1.0.0", state: "crashed", enabled: true, access: "read", availableVersion: null, repo: null, channel: null },
			{ id: "old", name: "Old", version: "0.1.0", state: "disabled", enabled: false, access: "read", availableVersion: null, repo: null, channel: null },
		]);
		expect((await core.call(session, "list_plugins")).text).toContain("- Old (old) 0.1.0: disabled");
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
		const state = agents.handle({ operation: "setEnabled", enabled: true }) as { command: string[]; commandWarning: string | null };
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
		expect((await cli("read", "tasks", "main", "--table", "things", "--parent", "t0")).out).toContain("## Table things, rows under t0: 0 rows");
		expect(JSON.parse((await cli("read", "tasks", "--json")).out)).toMatchObject({ plugin: "tasks", tree: { type: "page" } });
		// Calls from one parent process (this test) are one session in the audit log.
		await Bun.sleep(80);
		const sessions = new Set(readFileSync(join(dir, "agent-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.client === "toolbelt-cli").map((e) => e.session));
		expect(sessions.size).toBe(1);
		expect(state.commandWarning).toContain("ToolBelt's source at");
		expect((await cli("skill")).out).toContain("name: toolbelt");
		agents.stop();
		const off = await cli("status");
		expect(off.code).toBe(1);
		expect(off.err).toContain("Settings → Agents");
		server = undefined;
	});
});

describe("where the CLI and its setup commands point", () => {
	test("the CLI in an app bundle uses that app's folder: ToolBelt Dev's talks to ToolBelt Dev", () => {
		const files: Record<string, string> = {
			"/A/Toolbelt-dev.app/Contents/Resources/version.json": JSON.stringify({ channel: "dev" }),
			"/B/Toolbelt.app/Contents/Resources/version.json": JSON.stringify({ channel: "stable" }),
		};
		const read = (path: string) => {
			const normal = path.replace(/\/app\/cli\/\.\.\/\.\./, "");
			if (!(normal in files)) throw new Error("ENOENT");
			return files[normal];
		};
		expect(bundledSettingsFolder("/A/Toolbelt-dev.app/Contents/Resources/app/cli", read)).toBe("Toolbelt Dev");
		expect(bundledSettingsFolder("/B/Toolbelt.app/Contents/Resources/app/cli/", read)).toBe("Toolbelt");
		expect(bundledSettingsFolder("/src/cli", read)).toBeNull();
	});
	test("setup commands that point into a build or source folder carry a warning", () => {
		expect(commandWarning("/Applications/Toolbelt.app/Contents/Resources/app/cli/toolbelt.js")).toBeNull();
		expect(commandWarning("/Users/me/Applications/Toolbelt.app/Contents/Resources/app/cli/toolbelt.js")).toBeNull();
		const dev = commandWarning("/Users/me/worktrees/tb/build.noindex/dev-macos-arm64/Toolbelt-dev.app/Contents/Resources/app/cli/toolbelt.js")!;
		expect(dev).toContain("the ToolBelt build at /Users/me/worktrees/tb/build.noindex/dev-macos-arm64/Toolbelt-dev.app");
		expect(dev).toContain("when a worktree is removed");
		expect(commandWarning("/Users/me/dev/toolbelt/src/cli/toolbelt.ts")).toContain("ToolBelt's source at /Users/me/dev/toolbelt/src/cli/toolbelt.ts");
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
