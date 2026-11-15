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

test("SDK carries sections, reorder, rich fields and their events through the fake host", async () => {
	const h = harness();
	const events: [string, unknown][] = [];
	const tree = {
		type: "page" as const,
		children: [{ type: "table" as const, id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "a", cells: { x: "A" }, group: "inbox", unread: true }], sections: [{ id: "inbox", label: "Inbox" }, { id: "settled", label: "Settled", order: "fixed" as const, dropLabel: "Settle" }], reorder: true, selectEvents: true, actions: [{ id: "up", label: "Up", key: "alt+up" }] }],
		dialog: { id: "d", title: "Edit", children: [{ type: "form" as const, id: "f", fields: [{ type: "textarea" as const, id: "desc", label: "Description", value: "# Hi", markdown: true }, { type: "tags" as const, id: "l", label: "Labels", value: [{ key: "p", value: "High" }], keys: [{ key: "p", label: "Priority", color: "orange" as const, values: ["High"] }] }] }] },
	};
	definePlugin({ render: { "screen:a": () => tree }, onEvent: (_s, name, payload) => { events.push([name, payload]); } }, { write: h.write, input: h.input });
	await tick();
	h.send({ type: "hello", protocol: 1, capabilities: ["ui.core", "ui.rich-fields", "ui.row-select", "ui.row-reorder", "ui.modifier-keys"], plugin: { id: "t" }, host: { name: "test", version: "0.3.9" } });
	h.send({ type: "open", surface: "screen:a" });
	h.send({ type: "event", surface: "screen:a", name: "reorder", payload: { table: "t", rowId: "a", section: "settled", before: null } });
	h.send({ type: "event", surface: "screen:a", name: "select", payload: { table: "t", rowId: "a" } });
	h.send({ type: "event", surface: "screen:a", name: "field", payload: { form: "f", field: "l", value: [{ key: "p", value: "High" }] } });
	await tick();
	expect(h.out.find((m: any) => m.type === "render")).toEqual({ type: "render", surface: "screen:a", tree });
	expect(events.map(([n]) => n)).toEqual(["reorder", "select", "field"]);
	expect(validateTree(tree)).toBeUndefined();
});
