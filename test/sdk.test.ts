// The plugin SDK with an in-memory host.
import { expect, test } from "bun:test";
import { definePlugin } from "../src/sdk";
import type { HostMessage, PluginMessage } from "../src/shared/protocol";
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
	h.send({ type: "hello", protocol: 1, plugin: { id: "t" }, host: { name: "test", version: "0" } });
	h.send({ type: "open", surface: "screen:a" });
	await tick();
	expect(h.out).toEqual([{ type: "render", surface: "screen:a", tree: { type: "text", text: "n=0" } }]);

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
	expect(h.out.at(-1)).toEqual({ type: "render", surface: "screen:a", tree: { type: "text", text: "n=1" } });

	h.send({ type: "close", surface: "screen:a" });
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
	h.send({ type: "open", surface: "quick" });
	await tick();
	expect(h.out[0]).toMatchObject({ type: "render", surface: "quick", tree: { type: "empty", description: "nope" } });
});

test("events reach onEvent with the surface and payload", async () => {
	const h = harness();
	const seen: unknown[] = [];
	definePlugin({ render: {}, onEvent: (surface, name, payload) => void seen.push([surface, name, payload]) }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "event", surface: "screen:a", name: "action", payload: { rowId: "7" } });
	await tick();
	expect(seen).toEqual([["screen:a", "action", { rowId: "7" }]]);
});

test('host capabilities are negotiated independently of SDK version', async () => {
 const h=harness();let capabilities:string[]=[];
 definePlugin({render:{},start:ctx=>{capabilities=[...ctx.capabilities]}},{write:h.write,input:h.input});await tick();
 h.send({type:'hello',protocol:1,capabilities:['ui.core'],plugin:{id:'test'},host:{name:'old host',version:'0.1.0'}});await tick();
 expect(capabilities).toEqual(['ui.core']);
});

test("SDK preserves column-bound group summaries through the fake host", async () => {
 const h = harness();
 const tree = {type:"table" as const,id:"totals",columns:[{key:"name",title:"Name"},{key:"value",title:"Value"}],rows:[{id:"a",cells:{name:"A",value:42},group:[{label:"Group",summary:{label:"Total",value:"42",column:"value"}}]}]};
 definePlugin({render:{"screen:a":()=>tree}},{write:h.write,input:h.input});
 await tick();
 h.send({type:"hello",protocol:1,plugin:{id:"t"},host:{name:"test",version:"0.2.2"}});
 h.send({type:"open",surface:"screen:a"});
 await tick();
 expect(h.out.at(-1)).toEqual({type:"render",surface:"screen:a",tree});
});

test("navigate is sent only when the host offers it", async () => {
	const h = harness();
	const ctx = definePlugin({ render: {} }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 1, capabilities: ["ui.core"], plugin: { id: "t" }, host: { name: "test", version: "0" } });
	await tick();
	expect(ctx.navigate("main")).toBe(false);
	expect(h.out).toEqual([]);
	h.send({ type: "hello", protocol: 1, capabilities: ["ui.core", "navigate"], plugin: { id: "t" }, host: { name: "test", version: "0" } });
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
	h.send({ type: "hello", protocol: 1, capabilities: ["ui.core", "ui.row-reorder", "ui.row-tree", "ui.choice-control"], plugin: { id: "t" }, host: { name: "test", version: "0.3.18" } });
	h.send({ type: "open", surface: "screen:a" });
	h.send({ type: "event", surface: "screen:a", name: "reorder", payload: { table: "t", rowId: "2", section: "working", before: null, onto: "1" } });
	h.send({ type: "event", surface: "screen:a", name: "field", payload: { form: "subtasks", field: "subtasks", value: "parent" } });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", tree });
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
	h.send({ type: "hello", protocol: 1, capabilities: ["ui.core", "ui.row-tree", "ui.context-select", "ui.row-dot", "ui.section-pill", "ui.pane-buttons"], plugin: { id: "t" }, host: { name: "test", version: "0.3.19" } });
	h.send({ type: "open", surface: "screen:a" });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", tree });
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
	h.send({ type: "hello", protocol: 1, capabilities: ["ui.core", "ui.row-reorder", "ui.sub-sections", "ui.nested-sections", "ui.filter-group"], plugin: { id: "t" }, host: { name: "test", version: "0.3.17" } });
	h.send({ type: "open", surface: "screen:a" });
	h.send({ type: "event", surface: "screen:a", name: "filter-arrange", payload: { order: ["status", "project", "due"], grouped: ["status"] } });
	h.send({ type: "event", surface: "screen:a", name: "reorder", payload: { table: "t", rowId: "a", section: "web/inbox", before: null } });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", tree });
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
	h.send({ type: "hello", protocol: 1, capabilities: ["ui.core", "ui.rich-fields", "ui.row-select", "ui.row-reorder", "ui.modifier-keys", "ui.sub-sections", "ui.options-field"], plugin: { id: "t" }, host: { name: "test", version: "0.3.9" } });
	h.send({ type: "open", surface: "screen:a" });
	h.send({ type: "event", surface: "screen:a", name: "reorder", payload: { table: "t", rowId: "a", section: "snoozed", before: null } });
	h.send({ type: "event", surface: "screen:a", name: "select", payload: { table: "t", rowId: "a" } });
	h.send({ type: "event", surface: "screen:a", name: "field", payload: { form: "f", field: "l", value: [{ key: "p", value: "High" }] } });
	h.send({ type: "event", surface: "screen:a", name: "field", payload: { form: "f", field: "v", value: [{ key: "1", text: "Top", color: "red" }, { text: "Low", color: "sky" }] } });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", tree });
	expect(events.map(([n]) => n)).toEqual(["reorder", "select", "field", "field"]);
	expect(events.at(-1)![1]).toMatchObject({ field: "v", value: [{ key: "1", text: "Top" }, { text: "Low" }] });
	expect(validateTree(tree)).toBeUndefined();
});
