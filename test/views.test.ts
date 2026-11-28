// Views (docs/plugins.md, Views): the person's instance shared by every person's screen and saved by
// the host, private agent instances with their own view, through a real SDK plugin process.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../src/bun/host";
import { applyView, cleanView, resolveView, viewChange, viewProblem } from "../src/shared/views";
import { ViewStore } from "../src/bun/views";
import type { Node, ViewState } from "../src/shared/protocol";
import { until } from "./agent-scenarios/harness";

const SDK = join(import.meta.dir, "../src/sdk");
const roots: string[] = [];
const hosts: PluginHost[] = [];
afterEach(async () => {
	for (const h of hosts.splice(0)) for (const p of h.list()) await h.stopPlugin(p.manifest.id);
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A plugin whose list shows its view; "boom" in an agent view's search renders an invalid tree. */
function plugin() {
	const root = mkdtempSync(join(tmpdir(), "tb-views-"));
	roots.push(root);
	writeFileSync(join(root, "toolbelt.json"), JSON.stringify({ id: "list", name: "List", protocol: 3, agent: { access: "read" }, entry: "index.ts", screens: [{ id: "main", title: "Main" }] }));
	writeFileSync(
		join(root, "index.ts"),
		`import { definePlugin } from ${JSON.stringify(SDK)};
definePlugin({
	views: { "screen:main": { search: true, filters: { kind: ["a"] } } },
	render: {
		"screen:main": (_ctx, view) => view.search === "boom"
			? { type: "table", id: "t", columns: [{ key: "a", title: "A" }], rows: [{ id: "x", cells: { a: { text: {} } } }] }
			: {
				type: "page",
				search: { placeholder: "Search" },
				filters: [{ id: "kind", label: "Kind", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], selected: [] }],
				children: [{ type: "text", text: view.instance + ":" + view.search + ":" + view.filters.kind.join(",") }],
			},
	},
});`,
	);
	return root;
}

function world(root: string, saved?: Record<string, Record<string, ViewState>>) {
	const file = join(root, "views.json");
	if (saved) writeFileSync(file, JSON.stringify(saved));
	const views = new ViewStore(file, 0);
	const host = new PluginHost({ dirs: [root], bun: process.execPath, data: join(root, "data"), host: { name: "test", version: "0.1.0" }, views });
	hosts.push(host);
	const trees: { instance: string; tree: Node }[] = [];
	const personViews: ViewState[] = [];
	host.subscribe({ plugins: () => {}, tree: (_p, _s, tree, instance) => void trees.push({ instance, tree }), view: (_p, _s, v) => void personViews.push(v), toast: () => {} });
	host.start();
	return { host, trees, personViews, file };
}
const text = (tree: Node | null | undefined) => JSON.stringify(tree).match(/"text":"([^"]*:[^"]*)"/)?.[1];

test("the person's view is saved by the host and comes back when their instance opens", async () => {
	const root = plugin();
	const { host, personViews, file } = world(root, { list: { "screen:main": { search: "saved" } } });
	await until(() => host.list()[0]?.state === "running");
	host.open("list", "screen:main");
	await until(() => host.snapshot("list", "screen:main")?.tree);
	expect(text(host.snapshot("list", "screen:main")?.tree)).toBe("person:saved:a");
	expect((host.snapshot("list", "screen:main")?.tree as Extract<Node, { type: "page" }>).search?.query).toBe("saved");

	// A person's filter: the SDK applies it, the host saves it and tells its listeners.
	host.event("list", "screen:main", "filter", { filter: "kind", values: ["b"] });
	await until(() => text(host.snapshot("list", "screen:main")?.tree) === "person:saved:b");
	await until(() => personViews.length > 0);
	expect(personViews.at(-1)).toEqual({ search: "saved", filters: { kind: ["b"] } });
	await until(() => JSON.parse(readFileSync(file, "utf8")).list?.["screen:main"]?.filters);
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ list: { "screen:main": { search: "saved", filters: { kind: ["b"] } } } });

	// The host sets the person's view (an agent showing something): applied, echoed, saved.
	host.setView("list", "screen:main", "person", { search: "shown" });
	await until(() => text(host.snapshot("list", "screen:main")?.tree) === "person:shown:a");
	expect(host.personView("list", "screen:main")).toEqual({ search: "shown" });
});

test("agent instances render their own view, never reach the person's, and survive a restart", async () => {
	const root = plugin();
	const { host, trees } = world(root);
	await until(() => host.list()[0]?.state === "running");
	expect(host.declaredView("list", "screen:main")).toEqual({ search: true, filters: { kind: ["a"] } });
	host.open("list", "screen:main");
	host.open("list", "screen:main", "agent:x", { filters: { kind: [] } });
	await until(() => host.snapshot("list", "screen:main", "agent:x")?.tree && host.snapshot("list", "screen:main")?.tree);
	expect(text(host.snapshot("list", "screen:main", "agent:x")?.tree)).toBe("agent:x::");
	expect(text(host.snapshot("list", "screen:main")?.tree)).toBe("person::a");
	expect(trees.filter((t) => t.instance === "agent:x")).toHaveLength(1);
	expect(host.snapshot("list", "screen:main", "agent:x")?.viewers).toBe(1);

	// A restarted plugin gets both instances back, each with its view.
	await host.restart("list");
	await until(() => host.snapshot("list", "screen:main", "agent:x")?.tree && host.snapshot("list", "screen:main")?.tree);
	expect(text(host.snapshot("list", "screen:main", "agent:x")?.tree)).toBe("agent:x::");

	// An invalid render costs only its instance.
	host.open("list", "screen:main", "agent:boom", { search: "boom" });
	await until(() => host.snapshot("list", "screen:main", "agent:boom")?.error);
	expect(host.list()[0].state).toBe("running");
	expect(text(host.snapshot("list", "screen:main")?.tree)).toBe("person::a");

	// Closing an agent instance forgets it.
	host.close("list", "screen:main", "agent:x");
	expect(host.snapshot("list", "screen:main", "agent:x")).toMatchObject({ tree: null, viewers: 0 });
});

test("a plugin's runtime declarations replace its handshake's", async () => {
	const root = mkdtempSync(join(tmpdir(), "tb-views-"));
	roots.push(root);
	writeFileSync(join(root, "toolbelt.json"), JSON.stringify({ id: "labels", name: "Labels", protocol: 3, agent: { access: "read" }, entry: "index.ts", screens: [{ id: "main", title: "Main" }] }));
	writeFileSync(
		join(root, "index.ts"),
		`import { definePlugin } from ${JSON.stringify(SDK)};
let labels = ["home"];
definePlugin({
	views: () => ({ "screen:main": { filters: Object.fromEntries(labels.map((l) => ["label:" + l, []])) } }),
	actions: { add: { effect: "write" } },
	render: { "screen:main": () => ({ type: "page", actions: [{ id: "add", label: "Add" }], children: [{ type: "text", text: labels.join(",") }] }) },
	onEvent: (_s, name, _p, ctx) => { if (name === "add") { labels = [...labels, "work"]; ctx.declare(); } },
});`,
	);
	const { host } = world(root);
	await until(() => host.list()[0]?.state === "running");
	expect(host.declaredView("labels", "screen:main")).toEqual({ filters: { "label:home": [] } });
	host.open("labels", "screen:main");
	await until(() => host.snapshot("labels", "screen:main")?.tree);
	host.event("labels", "screen:main", "add");
	await until(() => Object.keys(host.declaredView("labels", "screen:main")?.filters ?? {}).length === 2);
	expect(host.declaredView("labels", "screen:main")).toEqual({ filters: { "label:home": [], "label:work": [] } });
	expect(host.list()[0].state).toBe("running");
});

test("cleanView: a cleared sort stays cleared; options and removed filters are dropped", () => {
	const declared = {
		filters: { status: ["open"], kind: [] },
		sort: { t: { key: "due", desc: false } },
		controls: { mode: "list" },
		arrange: { order: ["status", "kind"], grouped: [] },
		options: { filters: { status: ["open", "done"] }, controls: { mode: ["list", "board"] } },
	};
	expect(cleanView(declared, { sort: { t: null } })).toEqual({ sort: { t: null } });
	expect(resolveView(declared, { sort: { t: null } }, "person").sort).toEqual({ t: null });
	expect(cleanView(declared, { filters: { status: ["done", "archived"] }, controls: { mode: "grid" } })).toEqual({ filters: { status: ["done"] } });
	// Every value gone: back to the default, not "all".
	expect(cleanView(declared, { filters: { status: ["archived"] } })).toEqual({});
	expect(cleanView(declared, { filters: { status: [] } })).toEqual({ filters: { status: [] } });
	expect(cleanView(declared, { arrange: { order: ["gone", "kind", "status"], grouped: ["gone", "kind"] } })).toEqual({ arrange: { order: ["kind", "status"], grouped: ["kind"] } });
	expect(viewProblem(declared, { filters: { status: ["open", "archived"] } })).toBe(`filter "status" has no option "archived"`);
	expect(viewProblem(declared, { controls: { mode: "grid" } })).toBe(`control "mode" has no option "grid"`);
	expect(viewProblem(declared, { filters: { kind: ["anything"] }, controls: { mode: "board" } })).toBeNull();
	expect(viewChange(declared, {}, "sort", { table: "t", key: null, desc: false })).toEqual({ sort: { t: null } });
	expect(viewChange(declared, {}, "sort", { table: "t", key: "due", desc: true })).toEqual({ sort: { t: { key: "due", desc: true } } });
});

test("applyView fills the sort of tables in cards, stacks and the page's dialog", () => {
	const table = (id: string, sort?: { key: string; desc: boolean }): Node => ({ type: "table", id, columns: [{ key: "n", title: "N", sortable: true }], rows: [], ...(sort ? { sort } : {}) });
	const declared = { sort: { a: null, b: { key: "n", desc: true }, c: { key: "n", desc: false } } };
	const tree: Node = {
		type: "page",
		children: [{ type: "card", children: [{ type: "stack", children: [table("a", { key: "n", desc: false })] }] }, table("b")],
		dialog: { id: "d", title: "D", children: [table("c")] },
	};
	const out = applyView(tree, resolveView(declared, {}, "person"), declared) as Extract<Node, { type: "page" }>;
	const card = out.children[0] as Extract<Node, { type: "card" }>;
	expect(((card.children[0] as Extract<Node, { type: "stack" }>).children[0] as Extract<Node, { type: "table" }>).sort).toBeUndefined();
	expect((out.children[1] as Extract<Node, { type: "table" }>).sort).toEqual({ key: "n", desc: true });
	expect((out.dialog!.children[0] as Extract<Node, { type: "table" }>).sort).toEqual({ key: "n", desc: false });
});
