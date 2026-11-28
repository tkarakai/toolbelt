// The action resolver (src/shared/actions.ts): every place a tree offers an event, the payloads
// the renderer builds for them, and the refusals for events the tree doesn't offer.
import { describe, expect, test } from "bun:test";
import { checkEvent, inPane, isRefused, payloadFor, resolve, undeclared, type Address, type Resolved } from "../src/shared/actions";
import type { Node, Row } from "../src/shared/protocol";

const ok = (r: ReturnType<typeof checkEvent>) => {
	if (isRefused(r)) throw new Error(`refused: ${r.refused}`);
	return r as Resolved;
};
const refused = (r: ReturnType<typeof checkEvent>) => (isRefused(r) ? r.refused : null);

const row = (id: string, title: string, extra: Partial<Row> = {}): Row => ({ id, cells: { title }, ...extra });

/** A screen with one of every addressable node. */
const tree: Node = {
	type: "page",
	search: { placeholder: "Search" },
	actions: [
		{ id: "new", label: "New", primary: true },
		{ id: "note", label: "Note", input: { placeholder: "What?" } },
		{ id: "archive", label: "Archive", disabled: true },
		{ id: "update", label: "Update", menu: [{ id: "update-review", label: "Review first" }, { id: "update-later", label: "Later", disabled: true }] },
	],
	controls: [{ type: "segmented", id: "layout", value: "list", options: [{ value: "list", label: "List" }, { value: "board", label: "Board" }] }],
	filters: [
		{ id: "status", label: "Status", options: [{ value: "open", label: "Open" }], selected: [], group: true },
		{ id: "owner", label: "Owner", options: [{ value: "me", label: "Me" }], selected: [] },
	],
	children: [
		{
			type: "table",
			id: "tasks",
			columns: [{ key: "title", title: "Task", sortable: true }, { key: "due", title: "Due" }],
			actions: [
				{ id: "done", label: "Done", inline: true },
				{ id: "delete", label: "Delete", tone: "destructive", confirm: "Delete it?" },
				{ id: "open", label: "Open", menu: [{ id: "open-in", label: "Open in…" }] },
				{ id: "snooze", label: "Snooze", input: {} },
				{ id: "stop", label: "Stop" },
			],
			bulkActions: [{ id: "done-all", label: "Done", menu: [{ id: "delete-all", label: "Delete" }] }],
			selectEvents: true,
			reorder: true,
			reorderOnto: "Make it a subtask",
			contextSelect: true,
			sections: [{ id: "today", label: "Today" }, { id: "later", label: "Later", sections: [{ id: "someday", label: "Someday" }] }],
			rows: [
				row("1", "Fix login", { group: "today", actions: ["done", "delete", "open", "snooze"], children: [row("1a", "Write test")] }),
				row("2", "Ship it", { group: "later", actions: ["stop"], targets: { stop: [{ id: "job", label: "The job" }, { id: "proc", label: "A process" }] } }),
				row("c1@later", "Fix login", { group: "later", context: "1", actions: ["done", "stop"] }),
				row("3", "Read mail", {
					group: "today",
					details: [
						{ label: "Note", value: "…", actions: [{ id: "edit-note", label: "Edit" }], target: "n1" },
						{ label: "Parent", value: "Fix login", actions: [{ id: "peek", label: "Peek" }], actionRow: "c1@later" },
					],
				}),
				row("4", "Plan offsite", {
					group: "today",
					pane: [
						{ type: "form", id: "task", appearance: "inline", fields: [
							{ type: "text", id: "title", label: "Title", value: "Plan offsite" },
							{ type: "switch", id: "flag", label: "Flag", value: false },
							{ type: "select", id: "size", label: "Size", value: "s", options: [{ value: "s", label: "S" }, { value: "m", label: "M" }] },
							{ type: "tags", id: "labels", label: "Labels", value: [{ key: "area", value: "home" }, { key: "urgent" }], keys: [{ key: "area", label: "Area" }, { key: "urgent", label: "Urgent", flag: true }], open: { id: "open-label", label: "Open" } },
							{ type: "duration", id: "estimate", label: "Estimate", value: 30 },
							{ type: "color", id: "color", label: "Color", value: "blue" },
							{ type: "options", id: "steps", label: "Steps", value: [{ key: "a", text: "A" }] },
							{ type: "environment", id: "env", label: "Env", value: [] },
						] },
						{ type: "card", id: "links", title: "Links", actions: [{ id: "add-link", label: "Add link" }], children: [] },
						{ type: "timeline", id: "history", edit: { id: "edit-entry", label: "Edit" }, actions: [{ id: "remove-entry", label: "Remove" }, { id: "reply", label: "Reply", input: {} }], entries: [
							{ id: "e1", at: 1, text: "hello" },
							{ id: "e2", at: 2, text: "locked", actions: [] },
						] },
						{ type: "composer", id: "comment", action: { id: "comment", label: "Comment" } },
						{ type: "choice", id: "mode", label: "Mode", value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
					],
				}),
				row("c4@later", "Plan offsite", { group: "later", context: "4", pane: [{ type: "form", id: "task", fields: [{ type: "text", id: "title", label: "Title", value: "" }] }] }),
			],
		},
		{ type: "card", id: "health", title: "Health", actions: [{ id: "check", label: "Check", menu: [{ id: "check-all", label: "Check all" }] }], children: [] },
		{ type: "card", title: "Anonymous", actions: [{ id: "poke", label: "Poke" }], children: [] },
		{
			type: "list",
			id: "inbox",
			open: { id: "open-item", label: "Open" },
			items: [{ id: "m1", title: "Welcome", actions: [{ id: "star", label: "Star", menu: [{ id: "star-blue", label: "Blue" }] }, { id: "reply-item", label: "Reply", input: {} }] }],
		},
		{ type: "form", id: "settings", fields: [
			{ type: "text", id: "key", label: "API key", value: "", secret: "api/key" },
			{ type: "environment", id: "vars", label: "Variables", value: [], secretPrefix: "vars" },
		] },
	],
	dialog: { id: "edit", title: "Edit task", actions: [{ id: "save", label: "Save", primary: true, menu: [{ id: "save-close", label: "Save and close" }] }, { id: "cancel", label: "Cancel", disabled: true }], children: [
		{ type: "form", id: "draft", fields: [{ type: "datetime", id: "due", label: "Due", value: "" }] },
	] },
};

describe("checkEvent: actions where the tree offers them", () => {
	test("page toolbar: enabled actions and split-button alternatives; input actions need text", () => {
		expect(ok(checkEvent(tree, "new", {}))).toMatchObject({ place: "toolbar", rows: [] });
		expect(ok(checkEvent(tree, "new", undefined)).payload).toEqual({});
		expect(refused(checkEvent(tree, "archive", {}))).toContain("disabled");
		expect(refused(checkEvent(tree, "invented", {}))).toBe('"invented" isn\'t offered on this screen');
		expect(refused(checkEvent(tree, "new", { rowId: "1" }))).toBeTruthy();
		ok(checkEvent(tree, "update-review", {}));
		expect(refused(checkEvent(tree, "update-later", {}))).toContain("disabled");
		ok(checkEvent(tree, "note", { text: "remember" }));
		expect(refused(checkEvent(tree, "note", {}))).toContain("needs text");
		expect(refused(checkEvent(tree, "new", { text: "x" }))).toContain("takes no text");
		expect(refused(checkEvent(tree, "new", [1]))).toBe("its payload isn't an object");
	});

	test("table rows: only the row's own actions, with their alternatives, targets and confirm", () => {
		expect(ok(checkEvent(tree, "done", { rowId: "1" }))).toMatchObject({ rows: [{ id: "1", title: "Fix login" }], place: 'row "Fix login" in table "tasks"' });
		expect(ok(checkEvent(tree, "delete", { rowId: "1" })).confirm).toBe("Delete it?");
		ok(checkEvent(tree, "open-in", { rowId: "1" }));
		ok(checkEvent(tree, "done", { rowId: "1a" })); // nested rows offer the table's actions
		expect(refused(checkEvent(tree, "done", { rowId: "2" }))).toBe('"done" isn\'t offered for row "2"');
		expect(refused(checkEvent(tree, "done", { rowId: "gone" }))).toBe('row "gone" isn\'t on the screen');
		ok(checkEvent(tree, "snooze", { rowId: "1", text: "tomorrow" }));
		expect(refused(checkEvent(tree, "snooze", { rowId: "1" }))).toContain("needs text");
		// Targets: one of the row's for the action, or none.
		ok(checkEvent(tree, "stop", { rowId: "2", target: "proc" }));
		ok(checkEvent(tree, "stop", { rowId: "2" }));
		expect(refused(checkEvent(tree, "stop", { rowId: "2", target: "other" }))).toBe('target "other" isn\'t offered for "stop"');
		expect(refused(checkEvent(tree, "done", { rowId: "1", target: "job" }))).toContain("target");
		expect(refused(checkEvent(tree, "done", { rowId: "1", extra: true }))).toBeTruthy();
	});

	test("context rows act as the row they stand for (contextSelect)", () => {
		// Only c1@later offers "stop" for row 1; its events name row 1, never itself.
		expect(ok(checkEvent(tree, "stop", { rowId: "1" })).place).toBe('row "Fix login" in table "tasks"');
		expect(refused(checkEvent(tree, "stop", { rowId: "c1@later" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "done", { rowId: "c1@later" }))).toBeTruthy();
		// Its drawer's events carry row 4's id too.
		expect(ok(checkEvent(tree, "field", { form: "task", field: "title", value: "x", rowId: "4" })).place).toContain("drawer");
	});

	test("bulk actions: every row must be shown, at least one", () => {
		expect(ok(checkEvent(tree, "done-all", { rowIds: ["1", "2"] })).rows).toEqual([{ id: "1", title: "Fix login" }, { id: "2", title: "Ship it" }]);
		ok(checkEvent(tree, "delete-all", { rowIds: ["1a"] }));
		expect(refused(checkEvent(tree, "done-all", { rowIds: ["1", "nope"] }))).toBe('row "nope" isn\'t on the screen');
		expect(refused(checkEvent(tree, "done-all", { rowIds: [] }))).toBeTruthy();
		expect(refused(checkEvent(tree, "done-all", {}))).toBeTruthy();
	});

	test("detail items: their row (or actionRow, rewritten) and their target", () => {
		ok(checkEvent(tree, "edit-note", { rowId: "3", target: "n1" }));
		expect(refused(checkEvent(tree, "edit-note", { rowId: "3" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "edit-note", { rowId: "3", target: "n2" }))).toBeTruthy();
		expect(ok(checkEvent(tree, "peek", { rowId: "1" })).rows).toEqual([{ id: "1", title: "Fix login" }]);
	});

	test("cards: boxed ones send their id, drawer sections the drawer's row", () => {
		ok(checkEvent(tree, "check", { rowId: "health" }));
		ok(checkEvent(tree, "check-all", { rowId: "health" }));
		ok(checkEvent(tree, "poke", {}));
		ok(checkEvent(tree, "add-link", { rowId: "4" }));
		expect(refused(checkEvent(tree, "add-link", { rowId: "links" }))).toBeTruthy();
	});

	test("dialogs: their actions with the dialog's id, and dialog-close for the open one", () => {
		expect(ok(checkEvent(tree, "save", { dialog: "edit" })).place).toBe('dialog "Edit task"');
		ok(checkEvent(tree, "save-close", { dialog: "edit" }));
		expect(refused(checkEvent(tree, "cancel", { dialog: "edit" }))).toContain("disabled");
		expect(refused(checkEvent(tree, "save", { dialog: "other" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "save", { dialog: "edit", text: "x" }))).toBeTruthy();
		ok(checkEvent(tree, "dialog-close", { dialog: "edit" }));
		expect(refused(checkEvent(tree, "dialog-close", { dialog: "closed" }))).toBe('dialog "closed" isn\'t open');
		ok(checkEvent(tree, "field", { form: "draft", field: "due", value: "2026-12-01" }));
	});

	test("lists: item actions with alternatives and input, and the list's open", () => {
		ok(checkEvent(tree, "star", { rowId: "m1" }));
		ok(checkEvent(tree, "star-blue", { rowId: "m1" }));
		ok(checkEvent(tree, "reply-item", { rowId: "m1", text: "thanks" }));
		expect(ok(checkEvent(tree, "open-item", { list: "inbox", item: "m1" })).rows).toEqual([{ id: "m1", title: "Welcome" }]);
		expect(refused(checkEvent(tree, "open-item", { list: "inbox", item: "m2" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "star", { rowId: "m2" }))).toBeTruthy();
	});

	test("timelines: entry actions where the entry allows them, edits with text", () => {
		ok(checkEvent(tree, "remove-entry", { timeline: "history", entryId: "e1", rowId: "4" }));
		expect(refused(checkEvent(tree, "remove-entry", { timeline: "history", entryId: "e2", rowId: "4" }))).toBeTruthy();
		// Editing in place is every entry's.
		ok(checkEvent(tree, "edit-entry", { timeline: "history", entryId: "e2", text: "new", rowId: "4" }));
		expect(refused(checkEvent(tree, "edit-entry", { timeline: "history", entryId: "e1", rowId: "4" }))).toContain("needs text");
		ok(checkEvent(tree, "reply", { timeline: "history", entryId: "e1", text: "ok", rowId: "4" }));
		expect(refused(checkEvent(tree, "remove-entry", { timeline: "history", entryId: "e1" }))).toBeTruthy();
	});

	test("composers: text required, in the drawer with its row", () => {
		ok(checkEvent(tree, "comment", { composer: "comment", text: "hi", rowId: "4" }));
		expect(refused(checkEvent(tree, "comment", { composer: "comment", text: "  ", rowId: "4" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "comment", { composer: "comment", text: "hi", rowId: "1" }))).toBeTruthy();
	});

	test("tags fields: open on a pill the field shows", () => {
		ok(checkEvent(tree, "open-label", { form: "task", field: "labels", key: "area", value: "home", rowId: "4" }));
		ok(checkEvent(tree, "open-label", { form: "task", field: "labels", key: "urgent", rowId: "4" }));
		expect(refused(checkEvent(tree, "open-label", { form: "task", field: "labels", key: "area", value: "work", rowId: "4" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "open-label", { form: "task", field: "labels", key: "urgent", value: "x", rowId: "4" }))).toBeTruthy();
	});

	test("a floating window: title bar actions and suggestions", () => {
		const floating: Node = { type: "floating", mode: "bar", actions: [{ id: "env", label: "Env" }, { id: "off", label: "Off", disabled: true }], suggestions: [{ id: "ask-hello", label: "Hello" }], children: [{ type: "composer", id: "ask", action: { id: "send", label: "Ask" } }] };
		ok(checkEvent(floating, "env", {}));
		ok(checkEvent(floating, "ask-hello", {}));
		ok(checkEvent(floating, "send", { composer: "ask", text: "hi" }));
		expect(refused(checkEvent(floating, "off", {}))).toContain("disabled");
		expect(refused(checkEvent(floating, "send", { composer: "ask" }))).toBeTruthy();
	});

	test("a plugin may name an action like a built-in event", () => {
		const t: Node = { type: "page", actions: [{ id: "select", label: "Select" }], children: [] };
		ok(checkEvent(t, "select", {}));
		expect(refused(checkEvent(t, "search", { query: "x" }))).toBe("this screen has no search");
	});
});

describe("checkEvent: fields and view events", () => {
	test("fields: the form and field exist (in the row's drawer when rowId is given) and the value fits", () => {
		ok(checkEvent(tree, "field", { form: "task", field: "flag", value: true, rowId: "4" }));
		expect(refused(checkEvent(tree, "field", { form: "task", field: "flag", value: "yes", rowId: "4" }))).toContain("a switch field");
		expect(refused(checkEvent(tree, "field", { form: "task", field: "flag", value: true }))).toContain("in a row's drawer");
		expect(refused(checkEvent(tree, "field", { form: "task", field: "flag", value: true, rowId: "1" }))).toContain('isn\'t in the drawer of row "1"');
		expect(refused(checkEvent(tree, "field", { form: "task", field: "nope", value: "", rowId: "4" }))).toContain("isn't on the screen");
		ok(checkEvent(tree, "field", { form: "task", field: "size", value: "m", rowId: "4" }));
		expect(refused(checkEvent(tree, "field", { form: "task", field: "size", value: "xl", rowId: "4" }))).toBeTruthy();
		ok(checkEvent(tree, "field", { form: "task", field: "labels", value: [{ key: "area", value: "work" }, { key: "urgent" }], rowId: "4" }));
		expect(refused(checkEvent(tree, "field", { form: "task", field: "labels", value: [{ value: "x" }], rowId: "4" }))).toBeTruthy();
		ok(checkEvent(tree, "field", { form: "task", field: "estimate", value: null, rowId: "4" }));
		ok(checkEvent(tree, "field", { form: "task", field: "estimate", value: 90, rowId: "4" }));
		ok(checkEvent(tree, "field", { form: "task", field: "color", value: "rose", rowId: "4" }));
		expect(refused(checkEvent(tree, "field", { form: "task", field: "color", value: "#fff", rowId: "4" }))).toBeTruthy();
		ok(checkEvent(tree, "field", { form: "task", field: "steps", value: [{ key: "a", text: "A2" }, { text: "B", color: "red" }], rowId: "4" }));
		ok(checkEvent(tree, "field", { form: "task", field: "env", value: [{ key: "A", value: "1", selected: true, secret: false }], rowId: "4" }));
		expect(refused(checkEvent(tree, "field", { form: "task", field: "env", value: [{ key: "A" }], rowId: "4" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "field", { form: "task", field: "title", value: "x", rowId: "4", extra: 1 }))).toContain('unexpected "extra"');
	});

	test("secret fields: the renderer's mark must name the field's secret", () => {
		ok(checkEvent(tree, "field", { form: "settings", field: "key", value: "sk-1", secret: "api/key" }));
		ok(checkEvent(tree, "field", { form: "settings", field: "key", value: null, secret: "api/key" }));
		ok(checkEvent(tree, "field", { form: "settings", field: "vars", value: [], secret: "vars" }));
		expect(refused(checkEvent(tree, "field", { form: "settings", field: "key", value: "sk-1", secret: "other" }))).toContain("isn't a secret field");
		expect(refused(checkEvent(tree, "field", { form: "task", field: "title", value: "x", secret: "api/key", rowId: "4" }))).toContain("isn't a secret field");
		// Refusal reasons never carry the value.
		expect(refused(checkEvent(tree, "field", { form: "settings", field: "renamed", value: "sk-secret", secret: "api/key" }))).not.toContain("sk-secret");
	});

	test("segmented and choice controls: an option of theirs", () => {
		ok(checkEvent(tree, "field", { form: "layout", field: "layout", value: "board" }));
		expect(refused(checkEvent(tree, "field", { form: "layout", field: "layout", value: "grid" }))).toBeTruthy();
		ok(checkEvent(tree, "field", { form: "mode", field: "mode", value: "b", rowId: "4" }));
		// A declared control the SDK keeps passes even when the tree doesn't show it.
		ok(checkEvent(tree, "field", { form: "density", field: "density", value: "compact" }, { controls: { density: "cozy" } }));
		expect(refused(checkEvent(tree, "field", { form: "density", field: "density", value: "compact" }))).toBeTruthy();
	});

	test("search, filters, arrangement and sort: shown on the page, or declared", () => {
		ok(checkEvent(tree, "search", { query: "login" }));
		expect(refused(checkEvent(tree, "search", { query: 3 }))).toBeTruthy();
		ok(checkEvent(tree, "filter", { filter: "status", values: ["open"] }));
		expect(refused(checkEvent(tree, "filter", { filter: "label", values: [] }))).toBe('filter "label" isn\'t on the screen');
		ok(checkEvent(tree, "filter", { filter: "label", values: [] }, { filters: { label: [] } }));
		ok(checkEvent(tree, "filter-arrange", { order: ["owner", "status"], grouped: ["owner"] }));
		expect(refused(checkEvent(tree, "filter-arrange", { order: ["owner"], grouped: [] }))).toBeTruthy();
		expect(refused(checkEvent(tree, "filter-arrange", { order: ["owner", "status"], grouped: ["x"] }))).toBeTruthy();
		ok(checkEvent(tree, "sort", { table: "tasks", key: "title", desc: true }));
		expect(refused(checkEvent(tree, "sort", { table: "tasks", key: "due", desc: true }))).toBeTruthy();
		ok(checkEvent(tree, "sort", { table: "tasks", key: "due", desc: true }, { sort: { tasks: null } }));
		const plain: Node = { type: "text", text: "nothing" };
		expect(refused(checkEvent(plain, "search", { query: "x" }))).toBe("this screen has no search");
		ok(checkEvent(plain, "search", { query: "x" }, { search: true }));
	});

	test("select: a selectEvents table and one of its rows, as the row's events name it", () => {
		ok(checkEvent(tree, "select", { table: "tasks", rowId: "1a" }));
		ok(checkEvent(tree, "select", { table: "tasks", rowId: null }));
		ok(checkEvent(tree, "select", { table: "tasks", rowId: "4" }));
		expect(refused(checkEvent(tree, "select", { table: "tasks", rowId: "c1@later" }))).toBeTruthy(); // stands for 1
		expect(refused(checkEvent(tree, "select", { table: "tasks", rowId: "gone" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "select", { table: "other", rowId: null }))).toBeTruthy();
	});

	test("reorder: a reorder table, its rows and sections; onto with reorderOnto", () => {
		ok(checkEvent(tree, "reorder", { table: "tasks", rowId: "1", section: "later", before: "2" }));
		ok(checkEvent(tree, "reorder", { table: "tasks", rowId: "1", section: "someday", before: null }));
		ok(checkEvent(tree, "reorder", { table: "tasks", rowId: "1a", section: "today", before: null, onto: "4" }));
		expect(refused(checkEvent(tree, "reorder", { table: "tasks", rowId: "1", section: "nowhere", before: null }))).toBeTruthy();
		expect(refused(checkEvent(tree, "reorder", { table: "tasks", rowId: "1", section: "today", before: "gone" }))).toBeTruthy();
		expect(refused(checkEvent(tree, "reorder", { table: "tasks", rowId: "gone", section: "today", before: null }))).toBeTruthy();
		expect(refused(checkEvent(tree, "reorder", { table: "tasks", rowId: "1", section: "today", before: null, onto: "gone" }))).toBeTruthy();
	});
});

describe("resolve: addresses for agents", () => {
	test("builds the renderer's payload and says what it acts on", () => {
		const r = resolve(tree, { kind: "action", action: "delete", row: "1" });
		expect(r).toEqual({ name: "delete", payload: { rowId: "1" }, action: expect.objectContaining({ id: "delete" }), place: 'row "Fix login" in table "tasks"', rows: [{ id: "1", title: "Fix login" }], confirm: "Delete it?" });
		expect(ok(resolve(tree, { kind: "action", action: "comment", composer: "comment", text: "hi", row: "4" })).payload).toEqual({ composer: "comment", text: "hi", rowId: "4" });
		expect(ok(resolve(tree, { kind: "field", form: "task", field: "flag", value: true, row: "4" })).payload).toEqual({ form: "task", field: "flag", value: true, rowId: "4" });
		expect(refused(resolve(tree, { kind: "action", action: "done", row: "2" }))).toBeTruthy();
		expect(refused(resolve(tree, { kind: "dialog-close", dialog: "nope" }))).toBeTruthy();
	});

	test("an action offered in several places needs narrowing", () => {
		const twice: Node = { type: "page", actions: [{ id: "refresh", label: "Refresh" }], children: [{ type: "card", title: "A", actions: [{ id: "refresh", label: "Refresh" }], children: [] }] };
		expect(refused(resolve(twice, { kind: "action", action: "refresh" }))).toContain("several places");
		const table: Node = { type: "stack", children: [
			{ type: "table", id: "a", columns: [{ key: "t", title: "T" }], rows: [{ id: "x", cells: { t: "X" } }], actions: [{ id: "go", label: "Go" }] },
			{ type: "table", id: "b", columns: [{ key: "t", title: "T" }], rows: [{ id: "x", cells: { t: "X" } }], actions: [{ id: "go", label: "Go" }] },
		] };
		expect(refused(resolve(table, { kind: "action", action: "go", row: "x" }))).toContain("several places");
		expect(ok(resolve(table, { kind: "action", action: "go", row: "x", table: "b" })).place).toBe('row "X" in table "b"');
	});
});

describe("payloadFor: byte for byte what the renderer sent", () => {
	// Each case: an address, and the JSON the renderer's object literals produced before payloadFor.
	const cases: [string, Address, string][] = [
		["toolbar", { kind: "action", action: "new" }, `{}`],
		["toolbar input", { kind: "action", action: "note", text: "x" }, `{"text":"x"}`],
		["row", { kind: "action", action: "done", row: "1" }, `{"rowId":"1"}`],
		["row target", { kind: "action", action: "stop", row: "2", target: "job" }, `{"rowId":"2","target":"job"}`],
		["row target input", { kind: "action", action: "stop", row: "2", target: "job", text: "why" }, `{"rowId":"2","target":"job","text":"why"}`],
		["bulk", { kind: "action", action: "done-all", rows: ["1", "2"] }, `{"rowIds":["1","2"]}`],
		["bulk input", { kind: "action", action: "done-all", rows: ["1"], text: "t" }, `{"rowIds":["1"],"text":"t"}`],
		["card", { kind: "action", action: "check", card: "health" }, `{"rowId":"health"}`],
		["dialog", { kind: "action", action: "save", dialog: "edit" }, `{"dialog":"edit"}`],
		["list item input", { kind: "action", action: "reply-item", row: "m1", text: "hi" }, `{"rowId":"m1","text":"hi"}`],
		["list open", { kind: "action", action: "open-item", list: "inbox", item: "m1" }, `{"list":"inbox","item":"m1"}`],
		["timeline", { kind: "action", action: "remove-entry", timeline: "history", entry: "e1" }, `{"timeline":"history","entryId":"e1"}`],
		["timeline edit in a drawer", { kind: "action", action: "edit-entry", timeline: "history", entry: "e1", text: "t", row: "4" }, `{"timeline":"history","entryId":"e1","text":"t","rowId":"4"}`],
		["composer", { kind: "action", action: "send", composer: "ask", text: "hi" }, `{"composer":"ask","text":"hi"}`],
		["composer in a drawer", { kind: "action", action: "comment", composer: "comment", text: "hi", row: "4" }, `{"composer":"comment","text":"hi","rowId":"4"}`],
		["tag open", { kind: "action", action: "open-label", form: "task", field: "labels", tag: { key: "area", value: "home" } }, `{"form":"task","field":"labels","key":"area","value":"home"}`],
		["flag open in a drawer", { kind: "action", action: "open-label", form: "task", field: "labels", tag: { key: "urgent" }, row: "4" }, `{"form":"task","field":"labels","key":"urgent","rowId":"4"}`],
		["field", { kind: "field", form: "settings", field: "key", value: "v", secret: "api/key" }, `{"form":"settings","field":"key","value":"v","secret":"api/key"}`],
		["field in a drawer", { kind: "field", form: "task", field: "flag", value: false, row: "4" }, `{"form":"task","field":"flag","value":false,"rowId":"4"}`],
		["control", { kind: "field", form: "layout", field: "layout", value: "board" }, `{"form":"layout","field":"layout","value":"board"}`],
		["dialog-close", { kind: "dialog-close", dialog: "edit" }, `{"dialog":"edit"}`],
		["select", { kind: "select", table: "tasks", row: null }, `{"table":"tasks","rowId":null}`],
		["reorder", { kind: "reorder", table: "tasks", row: "1", section: "later", before: null }, `{"table":"tasks","rowId":"1","section":"later","before":null}`],
		["reorder onto", { kind: "reorder", table: "tasks", row: "1", section: "today", before: null, onto: "4" }, `{"table":"tasks","rowId":"1","section":"today","before":null,"onto":"4"}`],
	];
	for (const [what, address, json] of cases) test(what, () => expect(JSON.stringify(payloadFor(address))).toBe(json));

	test("the drawer's rowId replaces a row the event had, in place, as the renderer's pane does", () => {
		expect(JSON.stringify(inPane({ rowId: "m1", text: "x" }, "4"))).toBe(`{"rowId":"4","text":"x"}`);
		expect(JSON.stringify(inPane({}, "4"))).toBe(`{"rowId":"4"}`);
	});

});

describe("undeclared: every action and form id a tree uses must be declared", () => {
	const ACTIONS = ["new", "note", "archive", "update", "update-review", "update-later", "done", "delete", "open", "open-in", "snooze", "stop", "done-all", "delete-all", "edit-note", "peek", "open-label", "add-link", "edit-entry", "remove-entry", "reply", "comment", "check", "check-all", "poke", "open-item", "star", "star-blue", "reply-item", "save", "save-close", "cancel"];
	const FORMS = ["task", "settings", "draft"];
	const all = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { effect: "write" }]));
	const view = { controls: { layout: "list" } };

	test("a tree whose ids are all declared passes; each missing one is named", () => {
		expect(undeclared(tree, { actions: all(ACTIONS), forms: all([...FORMS, "mode"]), view })).toBeNull();
		for (const id of ACTIONS) {
			const why = undeclared(tree, { actions: all(ACTIONS.filter((a) => a !== id)), forms: all([...FORMS, "mode"]), view });
			expect(why).toStartWith(`action "${id}" (`);
			expect(why).toEndWith("isn't declared in actions");
		}
		for (const id of FORMS) expect(undeclared(tree, { actions: all(ACTIONS), forms: all([...FORMS, "mode"].filter((f) => f !== id)), view })).toStartWith(`form "${id}" (`);
	});

	test("controls are view controls or declared forms", () => {
		// The page's `layout` is a view control; the drawer's `mode` choice isn't, so it's a form.
		expect(undeclared(tree, { actions: all(ACTIONS), forms: all(FORMS), view })).toBe(`control "Mode" in the drawer of "Plan offsite" isn't a declared view control or form`);
		expect(undeclared(tree, { actions: all(ACTIONS), forms: all([...FORMS, "mode"]) })).toBe(`control "layout" isn't a declared view control or form`);
		expect(undeclared(tree, { actions: all(ACTIONS), forms: all([...FORMS, "mode", "layout"]) })).toBeNull();
	});

	test("ids count before anything offers them: empty tables, lists, timelines and tag fields", () => {
		const empty: Node = {
			type: "stack",
			children: [
				{ type: "table", id: "t", columns: [{ key: "a", title: "A" }], rows: [], actions: [{ id: "row-action", label: "R", menu: [{ id: "row-alt", label: "Alt" }] }] },
				{ type: "list", id: "l", items: [], open: { id: "list-open", label: "Open" } },
				{ type: "timeline", id: "tl", entries: [], edit: { id: "entry-edit", label: "Edit" }, actions: [{ id: "entry-action", label: "E" }] },
				{ type: "form", id: "f", fields: [{ type: "tags", id: "tags", label: "Tags", value: [], keys: [], open: { id: "tag-open", label: "Open" } }] },
				{ type: "card", title: "C", actions: [{ id: "card-action", label: "C" }], children: [] },
			],
		};
		const ids = ["row-action", "row-alt", "list-open", "entry-edit", "entry-action", "tag-open", "card-action"];
		expect(undeclared(empty, { actions: all(ids), forms: all(["f"]) })).toBeNull();
		for (const id of ids) expect(undeclared(empty, { actions: all(ids.filter((a) => a !== id)), forms: all(["f"]) })).toStartWith(`action "${id}"`);
	});

	test("floating windows: title bar actions, suggestions and the composer", () => {
		const floating: Node = {
			type: "floating",
			mode: "bar",
			actions: [{ id: "settings", label: "Settings" }],
			suggestions: [{ id: "ask-hello", label: "Say hello" }],
			children: [{ type: "composer", id: "ask", action: { id: "send", label: "Ask" } }],
		};
		const ids = ["settings", "ask-hello", "send"];
		expect(undeclared(floating, { actions: all(ids) })).toBeNull();
		for (const id of ids) expect(undeclared(floating, { actions: all(ids.filter((a) => a !== id)) })).toStartWith(`action "${id}"`);
	});
});

describe("sort: a table can return to unsorted", () => {
	test("`key: null` passes for a table with a sortable column, or a declared sort", () => {
		ok(checkEvent(tree, "sort", { table: "tasks", key: null, desc: false }));
		expect(refused(checkEvent(tree, "sort", { table: "nope", key: null, desc: false }))).toBe(`table "nope" can't be sorted`);
		expect(refused(checkEvent(tree, "sort", { table: "tasks", key: 3, desc: false }))).toBe("its key must be text (or null: unsorted) and desc true or false");
	});
});
