// The plugin SDK with an in-memory host.
import { expect, test } from "bun:test";
import { definePlugin } from "../src/sdk";
import type { HostMessage, Node, PluginMessage } from "../src/shared/protocol";
import { validateTree } from "../src/shared/validation";

function harness() {
	const out: PluginMessage[] = [];
	let push: (m: HostMessage) => void = () => {};
	const input: AsyncIterable<Uint8Array> = {
		async *[Symbol.asyncIterator]() {
			const queue: HostMessage[] = [];
			let wake: (() => void) | null = null;
			push = (m) => (queue.push(m), wake?.());
			while (true) {
				if (!queue.length) await new Promise<void>((r) => (wake = r));
				wake = null;
				yield new TextEncoder().encode(JSON.stringify(queue.shift()) + "\n");
			}
		},
	};
	const write = (line: string) => JSON.parse(line).type!=="hello" && JSON.parse(line).type!=="ready" && out.push(JSON.parse(line));
	return { out, input, write, send: (m: HostMessage) => push(m) };
}

const tick = () => Bun.sleep(10);

test("renders open surfaces, skips unchanged trees, coalesces invalidations", async () => {
	const h = harness();
	let n = 0;
	let renders = 0;
	const ctx = definePlugin({ render: { "screen:a": () => (renders++, { type: "text", text: `n=${n}` }) } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 2, plugin: { id: "t" }, host: { name: "test", version: "0" } });
	h.send({ type: "open", surface: "screen:a", instance: "person" });
	await tick();
	expect(h.out).toEqual([{ type: "render", surface: "screen:a", instance: "person", tree: { type: "text", text: "n=0" } }]);

	ctx.invalidate();
	await tick();
	expect(h.out.length).toBe(1); // same tree: not sent again

	n = 1;
	renders = 0;
	ctx.invalidate();
	ctx.invalidate("screen:a");
	ctx.invalidate();
	await tick();
	expect(renders).toBe(1);
	expect(h.out.at(-1)).toEqual({ type: "render", surface: "screen:a", instance: "person", tree: { type: "text", text: "n=1" } });

	h.send({ type: "close", surface: "screen:a", instance: "person" });
	await tick();
	n = 2;
	ctx.invalidate();
	await tick();
	expect(h.out.length).toBe(2); // closed: nothing rendered
});

test("a render that throws shows an error view instead of killing the plugin", async () => {
	const h = harness();
	definePlugin({ render: { quick: () => { throw new Error("nope"); } } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "open", surface: "quick", instance: "person" });
	await tick();
	expect(h.out[0]).toMatchObject({ type: "render", surface: "quick", instance: "person", tree: { type: "empty", description: "nope" } });
});

test("events reach onEvent with the surface and payload", async () => {
	const h = harness();
	const seen: unknown[] = [];
	definePlugin({ render: {}, onEvent: (surface, name, payload) => void seen.push([surface, name, payload]) }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "action", payload: { rowId: "7" } });
	await tick();
	expect(seen).toEqual([["screen:a", "action", { rowId: "7" }]]);
});

test('host capabilities are negotiated independently of SDK version', async () => {
 const h=harness();let capabilities:string[]=[];
 definePlugin({render:{},start:ctx=>{capabilities=[...ctx.capabilities]}},{write:h.write,input:h.input});await tick();
 h.send({type:'hello',protocol:2,capabilities:['ui.core'],plugin:{id:'test'},host:{name:'old host',version:'0.1.0'}});await tick();
 expect(capabilities).toEqual(['ui.core']);
});

test("SDK preserves column-bound group summaries through the fake host", async () => {
 const h = harness();
 const tree = {type:"table" as const,id:"totals",columns:[{key:"name",title:"Name"},{key:"value",title:"Value"}],rows:[{id:"a",cells:{name:"A",value:42},group:[{label:"Group",summary:{label:"Total",value:"42",column:"value"}}]}]};
 definePlugin({render:{"screen:a":()=>tree}},{write:h.write,input:h.input});
 await tick();
 h.send({type:"hello",protocol:2,plugin:{id:"t"},host:{name:"test",version:"0.2.2"}});
 h.send({type:"open",surface:"screen:a", instance: "person"});
 await tick();
 expect(h.out.at(-1)).toEqual({type:"render",surface:"screen:a", instance: "person",tree});
});

test("navigate is sent only when the host offers it", async () => {
	const h = harness();
	const ctx = definePlugin({ render: {} }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 2, capabilities: ["ui.core"], plugin: { id: "t" }, host: { name: "test", version: "0" } });
	await tick();
	expect(ctx.navigate("main")).toBe(false);
	expect(h.out).toEqual([]);
	h.send({ type: "hello", protocol: 2, capabilities: ["ui.core", "navigate"], plugin: { id: "t" }, host: { name: "test", version: "0" } });
	await tick();
	expect(ctx.navigate("main", { select: "row-1" })).toBe(true);
	expect(ctx.navigate("other")).toBe(true);
	expect(h.out).toEqual([{ type: "navigate", screen: "main", select: "row-1" }, { type: "navigate", screen: "other" }]);
});

test("SDK carries context rows, drops onto rows and choice controls through the fake host", async () => {
	const h = harness();
	const events: [string, unknown][] = [];
	const tree = {
		type: "page" as const,
		controls: [{ type: "choice" as const, id: "subtasks", label: "Subtasks", value: "off", options: [{ value: "off", label: "Off" }, { value: "parent", label: "Follow their parent", section: "Subtask hierarchy" }] }],
		children: [{ type: "table" as const, id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "c1@working", cells: { x: "Parent" }, group: "working", context: "1", open: true, children: [{ id: "2", cells: { x: "Child" } }] }], sections: [{ id: "working", label: "Working" }], reorder: true, reorderOnto: "Make it a subtask" }],
	};
	definePlugin({ render: { "screen:a": () => tree }, onEvent: (_s, name, payload) => { events.push([name, payload]); } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 2, capabilities: ["ui.core", "ui.row-reorder", "ui.row-tree", "ui.choice-control"], plugin: { id: "t" }, host: { name: "test", version: "0.3.18" } });
	h.send({ type: "open", surface: "screen:a", instance: "person" });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "reorder", payload: { table: "t", rowId: "2", section: "working", before: null, onto: "1" } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "field", payload: { form: "subtasks", field: "subtasks", value: "parent" } });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", instance: "person", tree });
	expect(events.map(([n]) => n)).toEqual(["reorder", "field"]);
	expect(validateTree(tree)).toBeUndefined();
});
test("SDK carries selectable context rows, row dots, section pills and pane buttons through the fake host", async () => {
	const h = harness();
	const tree = {
		type: "page" as const,
		children: [{ type: "table" as const, id: "t", columns: [{ key: "x", title: "X" }], contextSelect: true, paneButtons: true, rows: [{ id: "c1@l1=a", cells: { x: "Parent" }, group: "l1=a", context: "1", dot: { color: "danger" as const, label: "Overdue" }, actions: ["settle"], pane: [{ type: "text" as const, text: "Parent" }] }], actions: [{ id: "settle", label: "Settle" }], sections: [{ id: "l1=a", label: "a", pill: { color: "orange" as const, shade: 1 } }] }],
	};
	definePlugin({ render: { "screen:a": () => tree } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 2, capabilities: ["ui.core", "ui.row-tree", "ui.context-select", "ui.row-dot", "ui.section-pill", "ui.pane-buttons"], plugin: { id: "t" }, host: { name: "test", version: "0.3.19" } });
	h.send({ type: "open", surface: "screen:a", instance: "person" });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", instance: "person", tree });
	expect(validateTree(tree)).toBeUndefined();
});
test("SDK carries nested sections, arranged filters and filter-arrange through the fake host", async () => {
	const h = harness();
	const events: [string, unknown][] = [];
	const tree = {
		type: "page" as const,
		filters: [
			{ id: "project", label: "Project", options: [{ value: "Web", label: "Web" }], selected: [], group: true },
			{ id: "status", label: "Status", options: [{ value: "inbox", label: "Inbox" }, { value: "archived", label: "Archived" }], selected: ["inbox"], group: true, default: { values: ["inbox"], label: "Ongoing" } },
			{ id: "due", label: "Due", options: [{ value: "today", label: "Today" }], selected: [], group: false, groupDisabled: "Up to 10 levels" },
		],
		controls: [{ type: "segmented" as const, id: "sub", value: "off", options: [{ value: "off", label: "Off" }] }],
		children: [{ type: "table" as const, id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "a", cells: { x: "A" }, group: "web/working" }], sections: [{ id: "web", label: "Web", sections: [{ id: "web/inbox", label: "Inbox" }, { id: "web/progressing", label: "Progressing", sections: [{ id: "web/working", label: "Working" }] }] }], reorder: true }],
	};
	definePlugin({ render: { "screen:a": () => tree }, onEvent: (_s, name, payload) => { events.push([name, payload]); } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 2, capabilities: ["ui.core", "ui.row-reorder", "ui.sub-sections", "ui.nested-sections", "ui.filter-group"], plugin: { id: "t" }, host: { name: "test", version: "0.3.17" } });
	h.send({ type: "open", surface: "screen:a", instance: "person" });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "filter-arrange", payload: { order: ["status", "project", "due"], grouped: ["status"] } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "reorder", payload: { table: "t", rowId: "a", section: "web/inbox", before: null } });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", instance: "person", tree });
	expect(events).toEqual([["filter-arrange", { order: ["status", "project", "due"], grouped: ["status"] }], ["reorder", { table: "t", rowId: "a", section: "web/inbox", before: null }]]);
	expect(validateTree(tree)).toBeUndefined();
});
test("SDK carries sections, sub-sections, reorder, rich fields and their events through the fake host", async () => {
	const h = harness();
	const events: [string, unknown][] = [];
	const tree = {
		type: "page" as const,
		children: [{ type: "table" as const, id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "a", cells: { x: "A" }, group: "inbox", unread: true }], sections: [{ id: "inbox", label: "Inbox" }, { id: "progressing", label: "Progressing", sections: [{ id: "snoozed", label: "Snoozed", empty: "Nothing snoozed", collapsed: true }] }, { id: "settled", label: "Settled", order: "fixed" as const, dropLabel: "Settle" }], reorder: true, selectEvents: true, actions: [{ id: "up", label: "Up", key: "alt+up" }] }],
		dialog: { id: "d", title: "Edit", children: [{ type: "form" as const, id: "f", fields: [{ type: "textarea" as const, id: "desc", label: "Description", value: "# Hi", markdown: true }, { type: "tags" as const, id: "l", label: "Labels", value: [{ key: "p", value: "High" }], keys: [{ key: "p", label: "Priority", color: "orange" as const, values: ["High"], colors: { High: "red" as const } }] }, { type: "options" as const, id: "v", label: "Values", value: [{ key: "1", text: "High", color: "red" as const, count: 2 }], colors: true, reorder: true, placeholder: "Add value" }] }] },
	};
	definePlugin({ render: { "screen:a": () => tree }, onEvent: (_s, name, payload) => { events.push([name, payload]); } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 2, capabilities: ["ui.core", "ui.rich-fields", "ui.row-select", "ui.row-reorder", "ui.modifier-keys", "ui.sub-sections", "ui.options-field"], plugin: { id: "t" }, host: { name: "test", version: "0.3.9" } });
	h.send({ type: "open", surface: "screen:a", instance: "person" });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "reorder", payload: { table: "t", rowId: "a", section: "snoozed", before: null } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "select", payload: { table: "t", rowId: "a" } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "field", payload: { form: "f", field: "l", value: [{ key: "p", value: "High" }] } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "field", payload: { form: "f", field: "v", value: [{ key: "1", text: "Top", color: "red" }, { text: "Low", color: "sky" }] } });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", instance: "person", tree });
	expect(events.map(([n]) => n)).toEqual(["reorder", "select", "field", "field"]);
	expect(events.at(-1)![1]).toMatchObject({ field: "v", value: [{ key: "1", text: "Top" }, { text: "Low" }] });
	expect(validateTree(tree)).toBeUndefined();
});

test("views: the SDK owns each instance's search, filters, sort and controls", async () => {
	const h = harness();
	const seen: string[] = [];
	const views: string[] = [];
	const ctx = definePlugin(
		{
			views: { "screen:a": { search: true, filters: { status: ["open"] }, sort: { items: null }, controls: { mode: "list" } } },
			render: {
				"screen:a": (_ctx, view) => ({
					type: "page",
					search: { placeholder: "Search" },
					filters: [{ id: "status", label: "Status", options: [{ value: "open", label: "Open" }, { value: "done", label: "Done" }], selected: [] }],
					controls: [{ type: "segmented", id: "mode", value: "", options: [{ value: "list", label: "List" }, { value: "board", label: "Board" }] }],
					children: [{ type: "table", id: "items", columns: [{ key: "name", title: "Name", sortable: true }], rows: [{ id: view.instance, cells: { name: `${view.search}|${view.filters.status.join(",")}|${view.controls.mode}` } }] }],
				}),
			},
			onEvent: (_s, name, _p, _c, { instance }) => void seen.push(`${name}@${instance}`),
			onView: (_s, view) => void views.push(view.instance),
		},
		{ write: h.write, input: h.input },
	);
	await tick();
	h.send({ type: "hello", protocol: 2, plugin: { id: "t" }, host: { name: "test", version: "0" } });
	h.send({ type: "open", surface: "screen:a", instance: "person", view: { search: "saved" } });
	await tick();
	const person = h.out.at(-1) as Extract<PluginMessage, { type: "render" }>;
	expect(person.instance).toBe("person");
	const page = person.tree as Extract<Node, { type: "page" }>;
	// The SDK writes the view into the tree's controls.
	expect(page.search?.query).toBe("saved");
	expect(page.filters?.[0].selected).toEqual(["open"]);
	expect((page.controls?.[0] as { value: string }).value).toBe("list");
	expect(JSON.stringify(page.children)).toContain("saved|open|list");

	// A person's filter event is the SDK's: it never reaches onEvent, and the host hears the view.
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "filter", payload: { filter: "status", values: ["done"] } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "sort", payload: { table: "items", key: "name", desc: true } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "field", payload: { form: "mode", field: "mode", value: "board" } });
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "settle", payload: { rowId: "1" } });
	await tick();
	expect(seen).toEqual(["settle@person"]);
	expect(views).toEqual(["person", "person", "person"]);
	expect(h.out.filter((m) => m.type === "view").at(-1)).toEqual({ type: "view", surface: "screen:a", instance: "person", view: { search: "saved", filters: { status: ["done"] }, sort: { items: { key: "name", desc: true } }, controls: { mode: "board" } } });
	const after = (h.out.filter((m) => m.type === "render").at(-1) as Extract<PluginMessage, { type: "render" }>).tree as Extract<Node, { type: "page" }>;
	expect((after.children[0] as Extract<Node, { type: "table" }>).sort).toEqual({ key: "name", desc: true });

	// An agent instance renders with its own view; the person's is untouched.
	h.send({ type: "open", surface: "screen:a", instance: "agent:x", view: { filters: { status: [] }, bogus: 1, controls: { nope: "y" } } as never });
	await tick();
	const agent = h.out.filter((m) => m.type === "render" && m.instance === "agent:x").at(-1) as Extract<PluginMessage, { type: "render" }>;
	expect(JSON.stringify(agent.tree)).toContain('"|' + "|list");
	expect(ctx.open.has("screen:a")).toBe(true);

	// The host sets the person's view: the SDK cleans it, echoes it and renders it.
	h.send({ type: "view", surface: "screen:a", instance: "person", view: { search: "shown", filters: { other: ["x"] } } });
	await tick();
	expect(h.out.filter((m) => m.type === "view").at(-1)).toEqual({ type: "view", surface: "screen:a", instance: "person", view: { search: "shown" } });

	// Closing one instance keeps the surface open for the other.
	h.send({ type: "close", surface: "screen:a", instance: "agent:x" });
	await tick();
	expect(ctx.open.has("screen:a")).toBe(true);
	h.send({ type: "close", surface: "screen:a", instance: "person" });
	await tick();
	expect(ctx.open.has("screen:a")).toBe(false);
});

test("views from data: declareViews re-reads them, tells the host and drops what's gone", async () => {
	const h = harness();
	const raw: string[] = [];
	let labels = ["home", "work"];
	const ctx = definePlugin(
		{
			views: () => ({ "screen:a": { filters: Object.fromEntries(labels.map((l) => [`label:${l}`, []])) } }),
			render: { "screen:a": (_c, view) => ({ type: "text", text: JSON.stringify(view.filters) }) },
		},
		{ write: (line) => (raw.push(line), h.write(line)), input: h.input },
	);
	await tick();
	h.send({ type: "hello", protocol: 2, plugin: { id: "t" }, host: { name: "test", version: "0" } });
	await tick();
	expect(JSON.parse(raw.find((l) => l.includes('"hello"'))!).views).toEqual({ "screen:a": { filters: { "label:home": [], "label:work": [] } } });
	h.send({ type: "open", surface: "screen:a", instance: "person", view: { filters: { "label:work": ["x"], "label:gone": ["y"] } } });
	await tick();
	expect(h.out.at(-1)).toMatchObject({ type: "render", tree: { text: '{"label:home":[],"label:work":["x"]}' } });
	labels = ["home", "garden"];
	ctx.declareViews();
	await tick();
	expect(h.out.find((m) => m.type === "views")).toEqual({ type: "views", views: { "screen:a": { filters: { "label:home": [], "label:garden": [] } } } });
	expect(h.out.at(-1)).toMatchObject({ type: "render", tree: { text: '{"label:home":[],"label:garden":[]}' } });
	// A filter that's declared now is the SDK's.
	h.send({ type: "event", surface: "screen:a", instance: "person", name: "filter", payload: { filter: "label:garden", values: ["roses"] } });
	await tick();
	expect(h.out.at(-1)).toMatchObject({ type: "render", tree: { text: '{"label:home":[],"label:garden":["roses"]}' } });
});

test("agentCommand reads the command ToolBelt passes to plugins, if any", async () => {
  const { agentCommand } = await import("../src/sdk");
  const before = process.env.TOOLBELT_AGENT_COMMAND;
  try {
    process.env.TOOLBELT_AGENT_COMMAND = JSON.stringify(["/bun", "/cli.js", "--socket", "/s"]);
    expect(agentCommand()).toEqual(["/bun", "/cli.js", "--socket", "/s"]);
    process.env.TOOLBELT_AGENT_COMMAND = "not json";
    expect(agentCommand()).toBeUndefined();
    delete process.env.TOOLBELT_AGENT_COMMAND;
    expect(agentCommand()).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.TOOLBELT_AGENT_COMMAND;
    else process.env.TOOLBELT_AGENT_COMMAND = before;
  }
});
