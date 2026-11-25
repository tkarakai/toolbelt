// Views (docs/plugins.md, Views): the person's instance shared by every person's screen and saved by
// the host, private agent instances with their own view, through a real SDK plugin process.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../src/bun/host";
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
	writeFileSync(join(root, "toolbelt.json"), JSON.stringify({ id: "list", name: "List", protocol: 2, agent: { access: "read" }, entry: "index.ts", screens: [{ id: "main", title: "Main" }] }));
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
