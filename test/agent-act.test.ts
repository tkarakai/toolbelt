// Agents act (docs/agent-interface.md, "Acting"; B1.3): choosing the action or form an agent names,
// values in each field's shape, what changed between renders, reads that say what can be done, write
// grants, routing, limits and the host's own checks on agents' events.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { changes, coerce, pickAction, pickForm, CHANGE_LINES } from "../src/bun/agent/act";
import { treeJson, treeText, type Declared } from "../src/bun/agent/serialize";
import { personRouting } from "../src/bun/agent";
import { agentSettings, effectiveAccess } from "../src/shared/agents";
import { offerings } from "../src/shared/actions";
import type { Field, Node } from "../src/shared/protocol";
import { createWorld, until, type World } from "./agent-scenarios/harness";

const declared: Declared = {
	actions: {
		new: { effect: "view" },
		save: { effect: "write" },
		done: { effect: "write" },
		"done-all": { effect: "write" },
		snooze: { effect: "write" },
		purge: { effect: "destructive" },
		open: { effect: "external" },
		secret: { effect: "write", agent: false },
		reply: { effect: "write" },
		star: { effect: "write" },
		refresh: { effect: "view" },
	},
	forms: { draft: { effect: "view" }, pane: { effect: "write" }, hidden: { effect: "write", agent: false } },
};

const tree = (dialog = false): Node => ({
	type: "page",
	actions: [{ id: "new", label: "New" }, { id: "refresh", label: "Refresh" }, { id: "secret", label: "Secret thing" }],
	children: [
		{ type: "card", id: "c1", title: "Inbox", actions: [{ id: "refresh", label: "Refresh" }], children: [] },
		{
			type: "table",
			id: "tasks",
			columns: [{ key: "title", title: "Title" }],
			actions: [{ id: "done", label: "Done" }, { id: "snooze", label: "Snooze", menu: [{ id: "star", label: "Star" }] }, { id: "purge", label: "Purge", confirm: "Purge it?" }, { id: "secret", label: "Secret thing" }],
			bulkActions: [{ id: "done-all", label: "Done" }],
			rows: [
				{ id: "t1", cells: { title: "Write report" }, targets: { snooze: [{ id: "tomorrow", label: "Tomorrow" }] }, pane: [{ type: "composer", id: "comments", action: { id: "reply", label: "Reply" } }, { type: "form", id: "pane", fields: [{ type: "select", id: "status", label: "Status", value: "todo", options: [{ value: "todo", label: "To do" }, { value: "done", label: "Done" }] }, { type: "text", id: "pin", label: "PIN", value: "", sensitive: true }] }] },
				{ id: "t2", cells: { title: "Call Ann" }, actions: ["done"] },
			],
		},
	],
	dialog: dialog
		? { id: "d", title: "New task", children: [{ type: "form", id: "draft", fields: [{ type: "text", id: "title", label: "Title", value: "Plan" }, { type: "switch", id: "urgent", label: "Urgent", value: false }] }], actions: [{ id: "save", label: "Save", primary: true }] }
		: undefined,
});

describe("which action an agent names", () => {
	test("offerings name every place with its kind and payload", () => {
		const kinds = offerings(tree(true)).actions.map((o) => `${o.kind}:${o.name}`);
		for (const k of ["toolbar:new", "card:refresh", "row:done", "row:star", "bulk:done-all", "composer:reply", "dialog:save"]) expect(kinds).toContain(k);
		expect(offerings(tree()).actions.find((o) => o.kind === "composer")!.payload).toEqual({ composer: "comments", rowId: "t1" });
	});
	test("by id or label; a shared label is refused with the ids", () => {
		const t = tree();
		const ok = pickAction(t, declared, { action: "SNOOZE", row: "t1", target: "tomorrow" });
		expect(ok).toMatchObject({ offering: { name: "snooze" }, payload: { rowId: "t1", target: "tomorrow" }, notes: [] });
		expect(pickAction(t, declared, { action: "Postpone", row: "t1" })).toMatchObject({ reason: "unknown action", refused: expect.stringContaining("Actions here: New, Refresh, Done, Snooze, Star, Purge, Reply") });
		expect(pickAction(t, declared, { action: "Done", rows: ["t1"] })).toMatchObject({ refused: expect.stringContaining("names more than one action: Done, Done [done-all]") });
		expect(pickAction(t, declared, { action: "star", row: "t1" })).toMatchObject({ offering: { name: "star" } });
	});
	test("rows address bulk actions; one row takes a bulk action too", () => {
		expect(pickAction(tree(), declared, { action: "done-all", rows: ["t1", "t2"] })).toMatchObject({ payload: { rowIds: ["t1", "t2"] }, rows: [{ id: "t1", title: "Write report" }, { id: "t2", title: "Call Ann" }] });
		expect(pickAction(tree(), declared, { action: "done-all", row: "t2" })).toMatchObject({ payload: { rowIds: ["t2"] } });
		expect(pickAction(tree(), declared, { action: "done-all", rows: ["t1", "nope"] })).toEqual({ missingRow: "nope" });
	});
	test("a row's own actions; a missing row is for the caller to explain", () => {
		expect(pickAction(tree(), declared, { action: "snooze", row: "t2" })).toMatchObject({ refused: expect.stringContaining("Its actions: Done") });
		expect(pickAction(tree(), declared, { action: "done", row: "t9" })).toEqual({ missingRow: "t9" });
		expect(pickAction(tree(), declared, { action: "done" })).toMatchObject({ reason: "needs a row" });
	});
	test("without rows: an open dialog first, then the page; several places are refused", () => {
		expect(pickAction(tree(true), declared, { action: "save" })).toMatchObject({ offering: { kind: "dialog", dialog: "d" }, payload: { dialog: "d" } });
		expect(pickAction(tree(), declared, { action: "refresh" })).toMatchObject({ reason: "offered in several places", refused: expect.stringContaining('card "Inbox"') });
		expect(pickAction(tree(true), declared, { action: "save", dialog: "other" })).toMatchObject({ reason: "dialog not open" });
	});
	test("text, targets, confirm and actions kept from agents", () => {
		expect(pickAction(tree(), declared, { action: "reply", row: "t1" })).toMatchObject({ reason: "needs text" });
		expect(pickAction(tree(), declared, { action: "reply", row: "t1", text: "On it" })).toMatchObject({ payload: { composer: "comments", rowId: "t1", text: "On it" } });
		expect(pickAction(tree(), declared, { action: "snooze", row: "t1", target: "never" })).toMatchObject({ reason: "unknown target" });
		expect(pickAction(tree(), declared, { action: "purge", row: "t1" })).toMatchObject({ offering: { action: { confirm: "Purge it?" } } });
		expect(pickAction(tree(), declared, { action: "Secret thing", row: "t1" })).toMatchObject({ reason: "not offered to agents" });
		expect(pickAction(tree(), declared, { action: "secret" })).toMatchObject({ reason: "not offered to agents" });
	});
});

describe("which form and values", () => {
	test("forms and fields by id or label, options by label, values in their field's shape", () => {
		const draft = pickForm(tree(true), declared, { form: "new task", values: { Title: "Ship", urgent: "yes" } }, 0);
		expect(draft).toMatchObject({ form: "draft", title: "New task", dialog: "d", entries: [{ payload: { form: "draft", field: "title", value: "Ship" } }, { payload: { form: "draft", field: "urgent", value: true } }] });
		const pane = pickForm(tree(), declared, { form: "pane", row: "t1", values: { Status: "Done" } }, 0);
		expect(pane).toMatchObject({ row: { id: "t1", title: "Write report" }, entries: [{ value: "done", shown: "Done", payload: { rowId: "t1" } }] });
	});
	test("refusals: a drawer form without its row, a sensitive field, a value that doesn't fit", () => {
		expect(pickForm(tree(), declared, { form: "pane", values: { status: "done" } }, 0)).toMatchObject({ reason: "needs a row" });
		expect(pickForm(tree(), declared, { form: "pane", row: "t1", values: { PIN: "1234" } }, 0)).toMatchObject({ reason: "secret field" });
		expect(pickForm(tree(), declared, { form: "pane", row: "t1", values: { status: "later" } }, 0)).toMatchObject({ reason: "value doesn't fit" });
		expect(pickForm(tree(), declared, { form: "pane", row: "t7", values: { status: "done" } }, 0)).toEqual({ missingRow: "t7" });
		expect(pickForm(tree(true), declared, { form: "draft", values: {} }, 0)).toMatchObject({ reason: "no values" });
	});
	test("coerce: switches, durations, tags, colors", () => {
		const tags: Field = { type: "tags", id: "labels", label: "Labels", value: [], keys: [{ key: "area", label: "Area", values: ["Home", "Work"] }, { key: "flag", label: "Flagged", flag: true }] };
		expect(coerce(tags, "area: work, Flagged")).toEqual({ value: [{ key: "area", value: "Work" }, { key: "flag" }] });
		expect(coerce(tags, "Area: Moon")).toMatchObject({ refused: expect.stringContaining("Its values: Home, Work") });
		expect(coerce({ type: "duration", id: "d", label: "D", value: null, none: "Never" }, "90")).toEqual({ value: 90 });
		expect(coerce({ type: "duration", id: "d", label: "D", value: null, none: "Never" }, "none")).toEqual({ value: null });
		expect(coerce({ type: "switch", id: "s", label: "S", value: false }, "maybe")).toMatchObject({ refused: expect.any(String) });
		expect(coerce({ type: "color", id: "c", label: "C", value: "red" }, "Blue")).toEqual({ value: "blue" });
	});
});

describe("what changed between renders", () => {
	test("rows added, removed and moved; fields; a dialog opening; at most 40 lines", () => {
		const before: Node = { type: "page", children: [{ type: "table", id: "t", columns: [{ key: "a", title: "A" }], sections: [{ id: "open", label: "Open" }, { id: "done", label: "Done" }], rows: [{ id: "1", group: "open", cells: { a: "One" } }, { id: "2", group: "open", cells: { a: "Two" } }] }] };
		const after: Node = { type: "page", children: [{ type: "table", id: "t", columns: [{ key: "a", title: "A" }], sections: [{ id: "open", label: "Open" }, { id: "done", label: "Done" }], rows: [{ id: "1", group: "done", cells: { a: "One" } }, { id: "3", group: "open", cells: { a: "Three" } }] }], dialog: { id: "d", title: "Edit", children: [] } };
		expect(changes(before, after, 0).lines).toEqual(['Dialog "Edit" opened.', "~ One  {id: 1} (moved from Open to Done)", "+ added: Three  {id: 3} (in Open)", "- removed: Two  {id: 2} (from Open)"]);
		const many = (n: number): Node => ({ type: "table", id: "t", columns: [{ key: "a", title: "A" }], rows: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, cells: { a: `Row ${i}` } })) });
		const diff = changes(many(0), many(60), 0);
		expect(diff.lines).toHaveLength(CHANGE_LINES);
		expect(diff.more).toBe(20);
		// Sensitive values stay masked.
		const field = (value: string): Node => ({ type: "form", id: "f", fields: [{ type: "text", id: "k", label: "Key", value, sensitive: true }] });
		expect(changes(field("a"), field("b"), 0).lines.join("\n")).not.toContain('"b"');
	});
});

describe("reads say what can be done, only at act", () => {
	test("acting reads list ids where they differ, effects, dialog actions and fillable forms; agent: false is left out at every level", () => {
		const acting = treeText(tree(true), { declared, acting: true, details: true }).text;
		expect(acting).toContain("Toolbar actions: New, Refresh");
		expect(acting).toContain("Row actions: Done (write), Snooze (write) (or: Star (write)), Purge (destructive, asks) (a row that allows fewer lists its own)");
		expect(acting).toContain("Dialog actions: Save (write)");
		expect(acting).toContain("## Form [draft] (fill_form; a draft: changes nothing until its action runs)");
		expect(acting).toContain("- PIN [pin] (not offered to agents): (empty)");
		expect(acting).not.toContain("Secret thing");
		const read = treeText(tree(true), { declared }).text;
		expect(read).toContain("Row actions: Done, Snooze (or: Star), Purge");
		expect(read).not.toContain("Dialog actions");
		expect(read).not.toContain("Secret thing");
		// Without declarations (a read as before): unchanged.
		expect(treeText(tree(), {}).text).toContain("Secret thing");
		const json = JSON.stringify(treeJson(tree(), { declared, acting: true, details: true }));
		expect(json).not.toContain("Secret thing");
		expect(json).toContain('"effect":"destructive"');
		expect(JSON.stringify(treeJson(tree(), { declared }))).not.toContain('"effect"');
	});
});

describe("access and settings", () => {
	test("act is the most a plugin declaring it allows; write grants are checked", () => {
		expect(effectiveAccess("act")).toBe("act");
		expect(effectiveAccess("act", "read")).toBe("read");
		const grant = { client: "claude-code", plugin: "ontrack", granted: 1, until: 2, duration: "today" };
		expect(agentSettings({ writeGrants: [grant, { ...grant, plugin: "" }, { ...grant, duration: "session" }, { ...grant, duration: "ever" }] }).writeGrants).toEqual([grant as never]);
	});
	test("routing: an agent's clipboard and navigation never reach the person; its toasts do for changes, as from it", () => {
		const core = { toastSource: (id: string) => (id === "write" ? "Claude Code" : null) } as never;
		const routing = personRouting(core);
		const agent = (id: string) => ({ id, actor: { kind: "agent" as const, client: "Claude Code", session: "s", mode: "interactive" as const } });
		const person = { id: "p", actor: { kind: "person" as const, via: "window" as const } };
		expect(routing.toast(agent("write"))).toEqual({ show: true, source: "Claude Code" });
		expect(routing.toast(agent("view"))).toEqual({ show: false });
		expect(routing.toast(person)).toEqual({ show: true });
		expect(routing.toast(undefined)).toEqual({ show: true });
		expect(routing.clipboard(agent("write"))).toBe(false);
		expect(routing.clipboard(person)).toBe(true);
		expect(routing.navigate(agent("view"))).toBe(false);
		expect(routing.navigate(person)).toBe(true);
	});
});

describe("the core acting on real plugins", () => {
	let world: World;
	beforeAll(async () => {
		world = await createWorld({ acting: true });
	});
	afterAll(async () => {
		await world.stop();
	});
	const rows = Array.from({ length: 201 }, (_, i) => `r${i}`);

	test("at most 30 changes a minute per session", async () => {
		const core = world.agents.core;
		const s = core.openSession("busy-agent", "interactive");
		for (let i = 0; i < 30; i++) expect((await core.call(s, "run_action", { plugin: "errands", action: "done-all", rows })).text).toContain("at most 200 rows");
		const limited = await core.call(s, "run_action", { plugin: "errands", action: "copy-list" });
		expect(limited).toMatchObject({ isError: true, kind: "refused" });
		expect(limited.text).toContain("30 changes in the last minute");
		// Another session isn't limited.
		expect((await core.call(core.openSession("other-agent", "interactive"), "run_action", { plugin: "errands", action: "copy-list" })).isError).toBeUndefined();
		core.closeSession(s);
	});

	test("a second call waits behind the first's approval; a this-session grant ends with its session", async () => {
		const core = world.agents.core;
		const s = core.openSession("queued-agent", "interactive");
		const order: string[] = [];
		const first = core.call(s, "run_action", { plugin: "errands", action: "done", row: "e1" }).then((r) => (order.push("first"), r));
		const second = core.call(s, "run_action", { plugin: "errands", action: "done", row: "e2" }).then((r) => (order.push("second"), r));
		const asked = await until(() => core.state().approvals.find((a) => a.change), 4000, "the first approval");
		await Bun.sleep(100);
		expect(core.state().approvals.filter((a) => a.change)).toHaveLength(1);
		world.agents.handle({ operation: "answer", id: asked.id, allow: true, scope: "grant", duration: "session" });
		expect((await first).text).toContain("The person allowed it");
		// The grant covers the second: it never asks.
		expect((await second).text).toContain("Allowed by the person's grant for changes in Errands (this session)");
		expect(order).toEqual(["first", "second"]);
		expect(core.state().writeGrants).toMatchObject([{ client: "queued-agent", plugin: "errands", pluginName: "Errands", session: s.id }]);
		core.closeSession(s);
		expect(core.state().writeGrants).toEqual([]);
	});

	test("saved grants are listed with the plugin's name and revoked", async () => {
		const core = world.agents.core;
		const s = core.openSession("granted-agent", "interactive");
		const pending = core.call(s, "fill_form", { plugin: "errands", form: "details", row: "e4", values: { note: "x" } });
		const asked = await until(() => core.state().approvals.find((a) => a.change), 4000, "the approval");
		expect(asked.change).toMatchObject({ kind: "fill", label: "details", effect: "write", rows: ["Order birthday cake"], rowCount: 1, grantable: true, fields: { values: [{ label: "Note", value: "x" }] } });
		world.agents.handle({ operation: "answer", id: asked.id, allow: true, scope: "grant", duration: "hour" });
		await pending;
		expect(world.settings().writeGrants).toMatchObject([{ client: "granted-agent", plugin: "errands", duration: "hour" }]);
		world.agents.handle({ operation: "revokeWriteGrant", client: "granted-agent", plugin: "errands" });
		expect(world.settings().writeGrants).toEqual([]);
		expect(core.state().writeGrants).toEqual([]);
	});

	test("lowering access below act refuses acting and drops the acting copies", async () => {
		const core = world.agents.core;
		const s = core.openSession("lowered-agent", "interactive");
		await core.call(s, "run_action", { plugin: "errands", action: "new-errand" });
		expect(world.host.snapshot("errands", "screen:list", `agent:${s.id}:list`)?.tree).toBeTruthy();
		world.agents.handle({ operation: "setAccess", plugin: "errands", access: "read" });
		expect(world.host.snapshot("errands", "screen:list", `agent:${s.id}:list`)?.viewers ?? 0).toBe(0);
		const r = await core.call(s, "run_action", { plugin: "errands", action: "new-errand" });
		expect(r).toMatchObject({ isError: true, kind: "refused" });
		expect(r.text).toContain("The person lets agents only read Errands");
		const read = await core.call(s, "read_screen", { plugin: "errands" });
		expect(read.text).not.toContain("[new-errand]");
		world.agents.handle({ operation: "setAccess", plugin: "errands", access: null });
	});

	test("the host refuses agents' events on the person's instance, select, reorder, kept actions and secret fields", () => {
		const actor = { kind: "agent" as const, client: "x", session: "s", mode: "interactive" as const };
		const host = world.host;
		expect(host.agentEvent("errands", "screen:list", "person", "copy-list", {}, actor, "none")).toMatchObject({ refused: expect.stringContaining("own instances") });
		host.open("errands", "screen:list", "agent:test:list", {});
		return until(() => host.snapshot("errands", "screen:list", "agent:test:list")?.tree, 4000, "render").then(() => {
			expect(host.agentEvent("errands", "screen:list", "agent:test:list", "select", { table: "errands", rowId: "e1" }, actor, "none")).toMatchObject({ refused: expect.stringContaining("isn't offered to agents") });
			expect(host.agentEvent("errands", "screen:list", "agent:test:list", "reset-code", { rowId: "e4" }, actor, "none")).toMatchObject({ refused: expect.stringContaining("isn't offered to agents") });
			expect(host.agentEvent("errands", "screen:list", "agent:test:list", "done", { rowId: "nope" }, actor, "none")).toMatchObject({ refused: expect.any(String) });
			expect(host.agentEvent("errands", "screen:debug", "agent:test:list", "done", { rowId: "e1" }, actor, "none")).toMatchObject({ refused: expect.any(String) });
			host.close("errands", "screen:list", "agent:test:list");
		});
	});
});
