// The agent interface (docs/agent-interface.md): access levels, the serializer, the core against a fake
// host, and the MCP socket and CLI end to end.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSettings, declaredAccess, effectiveAccess } from "../src/shared/agents";
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
	test("undeclared plugins are read-only; the person can only lower", () => {
		expect(declaredAccess({})).toBe("read");
		expect(declaredAccess({ agent: { access: "none" } })).toBe("none");
		expect(declaredAccess({ agent: { access: "bogus" } })).toBe("read");
		expect(effectiveAccess("read", "act")).toBe("read");
		expect(effectiveAccess("act", "none")).toBe("none");
		expect(effectiveAccess("none", "read")).toBe("none");
		expect(effectiveAccess("read")).toBe("read");
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
		installed: () => host.list().map((p) => ({ id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, enabled: true, ceiling: declaredAccess(p.manifest) })),
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

	test("a crashed plugin is reported, not read", async () => {
		const host = fakeHost([manifest("tasks")]);
		host.infos[0] = { ...host.infos[0], state: "crashed", error: "boom\nstack" };
		const { core } = makeCore(host);
		const r = await core.call(core.openSession("t", "interactive"), "read_screen", { plugin: "tasks" });
		expect(r).toEqual({ text: "Tasks is crashed: boom.", isError: true });
	});

	test("search finds lines across screens", async () => {
		const host = fakeHost([manifest("tasks"), manifest("notes")], (plugin, surface) =>
			surface === "screen:main" ? page(3) : { type: "text", text: `${plugin} settings: dark mode on` },
		);
		const { core } = makeCore(host);
		const r = await core.call(core.openSession("t", "interactive"), "search_screens", { query: "DARK mode" });
		expect(r.text).toContain("Tasks › Settings: tasks settings: dark mode on");
		expect(r.text).toContain("Notes › Settings: notes settings: dark mode on");
		expect((r.data as { matches: unknown[] }).matches).toHaveLength(2);
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
		expect(read.structuredContent.plugin).toBe("tasks");
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
		const page = l.query({ limit: 500, filter: { plugin: "tasks", outcome: "denied", mode: "interactive", since: 1_000_000 + 100_000 } });
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
