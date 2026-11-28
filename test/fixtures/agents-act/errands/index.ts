// Agent scenario fixture (test/agent-scenarios, B1.3 "Agents act"): an errand list agents may act
// on (`agent.access: "act"`). It has an action of every effect, one with `confirm`, a dialog with a
// draft form (`view`, per instance) and a row drawer form (`write`, with a sensitive field), an
// action kept from agents (`agent: false`), a toast with Undo, a bulk action, an action that
// returns `data`, one that copies text and one that navigates. The fixture-only `debug` screen
// shows its state as JSON for the harness's `expect.state`: how many times each event ran, the
// errands, what was removed and paid, and the open drafts.
import type { Node } from "../../../../src/shared/protocol";
import { definePlugin, type View } from "../../../../src/sdk";

type Errand = { id: string; title: string; store: string; done: boolean; note: string; priority: string; code: string };
const STORES = [
	{ value: "hardware", label: "Hardware store" },
	{ value: "cleaners", label: "Dry cleaners" },
	{ value: "library", label: "Library" },
	{ value: "bakery", label: "Bakery" },
];
const errand = (id: string, title: string, store: string, done = false): Errand => ({ id, title, store, done, note: "", priority: "normal", code: "" });
let errands: Errand[] = [
	errand("e1", "Buy light bulbs", "hardware"),
	errand("e2", "Pick up dry cleaning", "cleaners"),
	errand("e3", "Return library books", "library", true),
	errand("e4", "Order birthday cake", "bakery"),
];
let next = 5;
const counts: Record<string, number> = {};
const removed: string[] = [];
const paid: string[] = [];
/** Each instance's New errand dialog draft, while it's open. */
const drafts = new Map<string, { title: string; store: string; urgent: boolean }>();

const storeLabel = (v: string) => STORES.find((s) => s.value === v)?.label ?? v;

function list(view: View): Node {
	const status = view.filters.status ?? [];
	const query = view.search.toLowerCase();
	const shown = errands.filter((e) => (!status.length || status.includes(e.done ? "done" : "open")) && (!query || e.title.toLowerCase().includes(query)));
	const draft = drafts.get(view.instance);
	return {
		type: "page",
		search: { placeholder: "Search errands" },
		summary: `${errands.filter((e) => !e.done).length} open`,
		filters: [
			{
				id: "status",
				label: "Status",
				options: [
					{ value: "open", label: "Open", count: errands.filter((e) => !e.done).length },
					{ value: "done", label: "Done", count: errands.filter((e) => e.done).length },
				],
				selected: status,
				default: { values: ["open"], label: "Open" },
			},
		],
		actions: [
			{ id: "new-errand", label: "New errand", primary: true },
			{ id: "open-map", label: "Open map" },
			{ id: "copy-list", label: "Copy list" },
			{ id: "show-debug", label: "Show state" },
		],
		children: [
			{
				type: "table",
				id: "errands",
				columns: [{ key: "title", title: "Errand" }, { key: "store", title: "Store" }],
				actions: [
					{ id: "done", label: "Mark done" },
					{ id: "pay", label: "Pay", confirm: "Pay for this errand now?" },
					{ id: "remove", label: "Remove", tone: "destructive" },
					{ id: "reset-code", label: "Reset door code" },
				],
				bulkActions: [{ id: "done-all", label: "Mark done" }],
				sections: [{ id: "open", label: "Open" }, { id: "done", label: "Done" }],
				rows: shown.map((e) => ({
					id: e.id,
					group: e.done ? "done" : "open",
					cells: { title: e.title, store: storeLabel(e.store) },
					actions: e.done ? ["remove"] : undefined,
					pane: [
						{
							type: "form",
							id: "details",
							appearance: "inline",
							fields: [
								{ type: "text", id: "note", label: "Note", value: e.note },
								{ type: "select", id: "priority", label: "Priority", value: e.priority, options: ["low", "normal", "high"].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })) },
								{ type: "text", id: "code", label: "Door code", value: e.code, sensitive: true },
							],
						},
					],
				})),
			},
		],
		dialog: draft
			? {
					id: "new-errand",
					title: "New errand",
					children: [
						{
							type: "form",
							id: "draft",
							fields: [
								{ type: "text", id: "title", label: "Title", value: draft.title },
								{ type: "select", id: "store", label: "Store", value: draft.store, options: STORES },
								{ type: "switch", id: "urgent", label: "Urgent", value: draft.urgent },
							],
						},
					],
					actions: [{ id: "add", label: "Add errand", primary: true, disabled: !draft.title.trim() }],
				}
			: undefined,
	};
}

/** What the harness checks: no instance ids, so two sessions' drafts read the same everywhere. */
const state = () => ({
	counts,
	errands: errands.map(({ id, title, done, note, priority }) => ({ id, title, done, note, priority })),
	removed,
	paid,
	drafts: [...drafts.values()].map((d) => d.title).sort(),
});

definePlugin({
	views: { "screen:list": { search: true, filters: { status: ["open"] } } },
	actions: {
		"new-errand": { effect: "view" },
		add: { effect: "write", describe: "Adds the dialog's errand to the list" },
		done: { effect: "write" },
		undo: { effect: "write" },
		"done-all": { effect: "write" },
		pay: { effect: "write" },
		remove: { effect: "destructive" },
		"open-map": { effect: "external" },
		"copy-list": { effect: "view" },
		"show-debug": { effect: "view" },
		"reset-code": { effect: "write", agent: false },
	},
	forms: { draft: { effect: "view" }, details: { effect: "write" } },
	render: {
		"screen:list": (_ctx, view) => list(view),
		"screen:debug": () => ({ type: "page", children: [{ type: "text", text: JSON.stringify(state()) }] }),
	},
	onEvent(_surface, name, payload, ctx, { instance }) {
		counts[name] = (counts[name] ?? 0) + 1;
		const find = (id: unknown) => errands.find((e) => e.id === id);
		let result: { data: unknown } | undefined;
		if (name === "new-errand") drafts.set(instance, { title: "", store: "hardware", urgent: false });
		else if (name === "dialog-close") drafts.delete(instance);
		else if (name === "field" && payload.form === "draft") {
			const draft = drafts.get(instance);
			if (draft) (draft as Record<string, unknown>)[payload.field] = payload.value;
		} else if (name === "field" && payload.form === "details") {
			const e = find(payload.rowId);
			if (e) (e as Record<string, unknown>)[payload.field] = payload.value;
		} else if (name === "add") {
			const draft = drafts.get(instance);
			if (!draft) throw new Error("No draft is open");
			const id = `e${next++}`;
			errands.push(errand(id, draft.title, draft.store));
			drafts.delete(instance);
			result = { data: { id } };
		} else if (name === "done") {
			const e = find(payload.rowId);
			if (e) {
				e.done = true;
				ctx.toast(`Marked “${e.title}” done`, "success", { id: "undo", label: "Undo", payload: { id: e.id } });
			}
		} else if (name === "undo") {
			const e = find(payload.id);
			if (e) e.done = false;
		} else if (name === "done-all") for (const id of payload.rowIds) find(id) && (find(id)!.done = true);
		else if (name === "pay") paid.push(payload.rowId);
		else if (name === "remove") {
			errands = errands.filter((e) => e.id !== payload.rowId);
			removed.push(payload.rowId);
		} else if (name === "copy-list") ctx.copy(errands.filter((e) => !e.done).map((e) => e.title).join(", "));
		else if (name === "show-debug") ctx.navigate("debug");
		else if (name === "reset-code") {
			const e = find(payload.rowId);
			if (e) e.code = "";
		}
		ctx.invalidate();
		return result;
	},
});
