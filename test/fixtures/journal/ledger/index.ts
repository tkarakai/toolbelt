// Change journal fixture (test/journal.test.ts): every kind of event, with private text in row
// titles, field values and result data that must never reach the journal. Actions: `done`
// (write, on a row; returns data), `done-all` (write, bulk), `purge` (destructive, on a row; a
// toast with a write Undo), `open-link` (external), `skip` (not handled), `fail` (throws), `stall`
// (never answers), `new` (view: opens the dialog) and `create` (write: saves the dialog's draft).
// The table can be reordered (`reorder` events, journaled as writes).
// Forms: each row's `pane` (write), the page's `prefs` (write) and the dialog's `draft` (view).
import { definePlugin, type Node } from "../../../../src/sdk";

const rows = [
	{ id: "r1", title: "Secret title one" },
	{ id: "r2", title: "Private title two" },
];
const dialogs = new Set<string>();

definePlugin({
	views: { "screen:main": { search: true } },
	actions: {
		done: { effect: "write" },
		"done-all": { effect: "write" },
		purge: { effect: "destructive" },
		undo: { effect: "write" },
		"open-link": { effect: "external" },
		skip: { effect: "write" },
		fail: { effect: "write" },
		stall: { effect: "write" },
		new: { effect: "view" },
		create: { effect: "write" },
	},
	forms: { pane: { effect: "write" }, prefs: { effect: "write" }, draft: { effect: "view" } },
	render: {
		"screen:main": (_ctx, view): Node => ({
			type: "page",
			search: { placeholder: "Search" },
			actions: ["new", "open-link", "skip", "fail", "stall"].map((id) => ({ id, label: id })),
			children: [
				{ type: "form", id: "prefs", fields: [{ type: "text", id: "theme", label: "Theme", value: "" }] },
				{
					type: "table",
					id: "tasks",
					selectEvents: true,
					reorder: true,
					columns: [{ key: "title", title: "Title" }],
					actions: [{ id: "done", label: "Done" }, { id: "purge", label: "Purge" }],
					bulkActions: [{ id: "done-all", label: "Done" }],
					rows: rows.map((r) => ({
						id: r.id,
						cells: { title: r.title },
						pane: [{ type: "form", id: "pane", appearance: "inline", fields: [{ type: "text", id: "note", label: "Note", value: "" }] }],
					})),
				},
			],
			dialog: dialogs.has(view.instance)
				? { id: "draft", title: "New", children: [{ type: "form", id: "draft", fields: [{ type: "text", id: "name", label: "Name", value: "" }] }], actions: [{ id: "create", label: "Create", primary: true }] }
				: undefined,
		}),
	},
	async onEvent(_surface, name, _payload, ctx, { instance }) {
		if (name === "skip") return false;
		if (name === "fail") throw new Error("it broke");
		if (name === "stall") return new Promise<void>(() => {});
		if (name === "done") return { data: { token: "PLUGIN-DATA-PRIVATE" } };
		if (name === "purge") ctx.toast("Purged", "success", { id: "undo", label: "Undo" });
		if (name === "new") dialogs.add(instance), ctx.invalidate();
		if (name === "create") dialogs.delete(instance), ctx.invalidate();
	},
});
