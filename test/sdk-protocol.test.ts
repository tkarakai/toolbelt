// Protocol 3 in the SDK, through its fake host (src/sdk/testing.ts): declarations, event results,
// tags, origin, per-instance hooks, view options and refusals.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/sdk/testing";
import type { EventInfo, PluginDefinition } from "../src/sdk";
import { PERSON, type Node } from "../src/shared/protocol";
import { LIMITS } from "../src/shared/package";

const page = (actions: string[] = [], extra: Partial<Extract<Node, { type: "page" }>> = {}): Node => ({ type: "page", actions: actions.map((id) => ({ id, label: id })), children: [], ...extra });

function plugin(def: Partial<PluginDefinition>) {
	return fakeHost({ render: { "screen:a": () => page() }, ...def });
}

test("the hello carries views, actions and forms; functions are read again after start", async () => {
	let labels = ["home"];
	const h = plugin({
		views: () => ({ "screen:a": { filters: Object.fromEntries(labels.map((l) => [`label:${l}`, []])) } }),
		actions: { done: { effect: "write" }, delete: { effect: "destructive", agent: false, describe: "Deletes it for good" } },
		forms: () => ({ settings: { effect: "write" } }),
		start: async () => {
			labels = ["home", "work"]; // data loaded in start
		},
	});
	await h.hello();
	const hello = h.messages.find((m) => m.type === "hello")!;
	expect(hello.type === "hello" && hello.declarations).toEqual({
		views: { "screen:a": { filters: { "label:home": [] } } },
		actions: { done: { effect: "write" }, delete: { effect: "destructive", agent: false, describe: "Deletes it for good" } },
		forms: { settings: { effect: "write" } },
	});
	// Re-sent before ready without a manual declare().
	const types = h.messages.map((m) => m.type);
	expect(types).toEqual(["hello", "declarations", "ready"]);
	expect(h.declarations.views["screen:a"]?.filters).toEqual({ "label:home": [], "label:work": [] });
	expect(h.invalid).toEqual([]);
	h.close();
});

test("declarations unchanged by start aren't sent twice", async () => {
	const h = plugin({ actions: { go: { effect: "view" } }, start: async () => {} });
	await h.hello();
	expect(h.messages.map((m) => m.type)).toEqual(["hello", "ready"]);
	h.close();
});

test("built-in event names can't be action ids: the host refuses such a hello", async () => {
	const h = plugin({ actions: { select: { effect: "write" } } });
	await h.hello();
	expect(h.invalid[0]?.reason).toContain("message.declarations.actions.select");
	h.close();
});

test("a render using an undeclared action or form is what the host rejects", async () => {
	const h = fakeHost({
		actions: { ok: { effect: "write" } },
		render: {
			"screen:a": () => page(["ok", "nope"]),
			"screen:b": () => ({ type: "form", id: "settings", fields: [] }),
			"screen:c": () => page(["ok"], { controls: [{ type: "segmented", id: "mode", value: "a", options: [{ value: "a", label: "A" }] }] }),
		},
	});
	await h.hello();
	await h.open("screen:a");
	await h.open("screen:b");
	await h.open("screen:c");
	expect(h.rejected).toEqual([
		{ surface: "screen:a", instance: PERSON, reason: `action "nope" (toolbar) isn't declared in actions` },
		{ surface: "screen:b", instance: PERSON, reason: `form "settings" (form "settings") isn't declared in forms` },
		{ surface: "screen:c", instance: PERSON, reason: `control "mode" isn't a declared view control or form` },
	]);
	h.close();
});

test("results: handled, not handled, data, oversized data and thrown errors", async () => {
	const h = plugin({
		actions: { ok: { effect: "write" }, skip: { effect: "write" }, make: { effect: "write" }, huge: { effect: "write" }, bad: { effect: "write" } },
		onEvent: async (_s, name) => {
			if (name === "skip") return false;
			if (name === "make") return { data: { ids: ["t-1", "t-2"] } };
			if (name === "huge") return { data: "x".repeat(LIMITS.resultBytes + 1) };
			if (name === "bad") throw new Error("disk full");
		},
	});
	await h.hello();
	expect(await h.event("screen:a", "ok")).toMatchObject({ type: "result", handled: true });
	expect((await h.event("screen:a", "ok")).error).toBeUndefined();
	expect(await h.event("screen:a", "skip")).toMatchObject({ handled: false });
	expect(await h.event("screen:a", "make")).toMatchObject({ handled: true, data: { ids: ["t-1", "t-2"] } });
	const huge = await h.event("screen:a", "huge");
	expect(huge).toMatchObject({ handled: true, error: "onEvent's result: its data is larger than 64 KiB" });
	expect(huge.data).toBeUndefined();
	expect(await h.event("screen:a", "bad")).toMatchObject({ handled: true, error: "disk full" });
	expect(h.invalid).toEqual([]);
	h.close();
});

test("a plugin without onEvent answers every event as not handled", async () => {
	const h = plugin({});
	await h.hello();
	expect(await h.event("screen:a", "anything")).toMatchObject({ handled: false });
	h.close();
});

test("event info: id, instance, origin, the agent's name and the instance's view", async () => {
	const seen: EventInfo[] = [];
	const h = plugin({
		views: { "screen:a": { search: true } },
		actions: { go: { effect: "view" } },
		onEvent: (_s, _n, _p, _c, info) => void seen.push(info),
	});
	await h.hello();
	await h.open("screen:a", "agent:x", { search: "mine" });
	await h.event("screen:a", "go", {}, { instance: "agent:x", origin: "agent", agent: "Claude Code" });
	await h.event("screen:a", "go");
	expect(seen[0]).toMatchObject({ instance: "agent:x", origin: "agent", agent: "Claude Code", view: { instance: "agent:x", search: "mine" } });
	expect(seen[1]).toMatchObject({ instance: PERSON, origin: "person", view: { instance: PERSON, search: "" } });
	expect(seen[1]!.agent).toBeUndefined();
	expect(seen[0]!.id).not.toBe(seen[1]!.id);
	h.close();
});

test("toasts, clipboard and navigation sent while handling an event carry its id; later ones don't", async () => {
	let later: (() => void) | undefined;
	const h = plugin({
		actions: { go: { effect: "view" }, undo: { effect: "write" } },
		onEvent: async (_s, _n, _p, ctx) => {
			ctx.toast("Done", "success", { id: "undo", label: "Undo" });
			await Bun.sleep(5); // still the handler
			ctx.copy("text");
			ctx.navigate("b", { select: "1" });
			later = () => ctx.toast("Later");
			setTimeout(() => ctx.toast("Timer"), 20);
		},
	});
	await h.hello();
	const r = await h.event("screen:a", "go");
	expect(r.toasts.map((t) => t.text)).toEqual(["Done"]);
	expect(r.clipboard).toEqual(["text"]);
	expect(r.navigations).toEqual([{ screen: "b", select: "1" }]);
	later!();
	h.context.toast("Outside");
	await Bun.sleep(40);
	const untagged = h.messages.filter((m) => m.type === "toast" && m.event === undefined).map((m) => m.type === "toast" && m.text);
	expect(untagged).toEqual(["Later", "Outside", "Timer"]);
	h.close();
});

test("onOpen and onClose fire for every instance with its origin; ctx.open lists surfaces", async () => {
	const log: string[] = [];
	const h = plugin({
		onOpen: (s, ctx, { instance, origin }) => void log.push(`open ${s} ${instance} ${origin} ${ctx.open.has(s)}`),
		onClose: (s, ctx, { instance, origin }) => void log.push(`close ${s} ${instance} ${origin} ${ctx.open.has(s)}`),
	});
	await h.hello();
	await h.open("screen:a");
	await h.open("screen:a", "agent:x");
	await h.closeInstance("screen:a", "agent:x");
	await h.closeInstance("screen:a");
	await h.closeInstance("screen:a"); // already closed: nothing
	expect(log).toEqual(["open screen:a person person true", "open screen:a agent:x agent true", "close screen:a agent:x agent true", "close screen:a person person false"]);
	h.close();
});

test("onView fires when an instance opens with a view, and its false refuses any change", async () => {
	const views: string[] = [];
	const h = plugin({
		views: { "screen:a": { search: true } },
		onView: (_s, view) => (views.push(`${view.instance}:${view.search}`), view.search === "no" ? false : undefined),
	});
	await h.hello();
	await h.open("screen:a", PERSON, { search: "saved" });
	await h.open("screen:a", "agent:x"); // no view: no onView
	await h.open("screen:a", "agent:y", { search: "no" });
	expect(views).toEqual(["person:saved", "agent:y:no"]);
	expect(h.refusals).toEqual([{ surface: "screen:a", instance: "agent:y", view: {}, reason: "the plugin refused this view" }]);
	// The host setting a view, and a person's view event, refused the same way.
	await h.setView("screen:a", PERSON, { search: "no" });
	expect(h.refusals[1]).toEqual({ surface: "screen:a", instance: PERSON, view: { search: "saved" }, reason: "the plugin refused this view" });
	const r = await h.event("screen:a", "search", { query: "no" });
	expect(r).toMatchObject({ handled: false, error: "refused: the plugin refused this view" });
	expect(await h.event("screen:a", "search", { query: "yes" })).toMatchObject({ handled: true });
	h.close();
});

test("declared options: values outside them are refused, and dropped from a saved view", async () => {
	const h = plugin({
		views: { "screen:a": { filters: { status: ["open"] }, controls: { mode: "list" }, options: { filters: { status: ["open", "done"] }, controls: { mode: ["list", "board"] } } } },
		render: { "screen:a": (_c, view) => ({ type: "text", text: `${view.filters.status!.join(",")}|${view.controls.mode}` }) },
	});
	await h.hello();
	// The person's saved view outlived its data: stale values go quietly; an all-stale filter falls back to its default.
	await h.open("screen:a", PERSON, { filters: { status: ["archived"] }, controls: { mode: "grid" } });
	expect(h.tree("screen:a")).toEqual({ type: "text", text: "open|list" });
	expect(h.refusals).toEqual([]);
	// An agent's view with a value outside them is refused.
	await h.open("screen:a", "agent:x", { filters: { status: ["open", "archived"] } });
	expect(h.refusals[0]).toMatchObject({ instance: "agent:x", reason: `filter "status" has no option "archived"` });
	expect(h.tree("screen:a", "agent:x")).toEqual({ type: "text", text: "open|list" });
	expect(await h.event("screen:a", "field", { form: "mode", field: "mode", value: "grid" })).toMatchObject({ handled: false, error: `refused: control "mode" has no option "grid"` });
	expect(await h.event("screen:a", "filter", { filter: "status", values: ["done"] })).toMatchObject({ handled: true });
	expect(h.tree("screen:a")).toEqual({ type: "text", text: "done|list" });
	h.close();
});

test("sort: tables in cards and dialogs are filled, and a sort can be cleared", async () => {
	const table = (id: string): Node => ({ type: "table", id, columns: [{ key: "n", title: "N", sortable: true }], rows: [] });
	const h = plugin({
		views: { "screen:a": { sort: { inCard: { key: "n", desc: false }, inDialog: { key: "n", desc: true } } } },
		render: { "screen:a": () => ({ type: "page", children: [{ type: "card", title: "C", children: [table("inCard")] }], dialog: { id: "d", title: "D", children: [table("inDialog")] } }) },
	});
	await h.hello();
	await h.open("screen:a");
	const sorts = () => {
		const tree = h.tree("screen:a") as Extract<Node, { type: "page" }>;
		const card = tree.children[0] as Extract<Node, { type: "card" }>;
		return [(card.children[0] as Extract<Node, { type: "table" }>).sort, (tree.dialog!.children[0] as Extract<Node, { type: "table" }>).sort];
	};
	expect(sorts()).toEqual([{ key: "n", desc: false }, { key: "n", desc: true }]);
	expect(await h.event("screen:a", "sort", { table: "inCard", key: null, desc: false })).toMatchObject({ handled: true });
	expect(sorts()).toEqual([undefined, { key: "n", desc: true }]);
	expect(h.messages.filter((m) => m.type === "view").at(-1)).toEqual({ type: "view", surface: "screen:a", instance: PERSON, view: { sort: { inCard: null } } });
	h.close();
});

test("ctx.declare re-sends declarations and keeps only what is still declared", async () => {
	let ids = ["a", "b"];
	const h = fakeHost({
		actions: () => Object.fromEntries(ids.map((id) => [id, { effect: "write" as const }])),
		render: { "screen:a": () => page(ids) },
	});
	await h.hello();
	await h.open("screen:a");
	ids = ["a", "c"];
	h.context.declare();
	await h.idle();
	expect(Object.keys(h.declarations.actions)).toEqual(["a", "c"]);
	expect(h.rejected).toEqual([]);
	expect(JSON.stringify(h.tree("screen:a"))).toContain('"c"');
	h.close();
});
