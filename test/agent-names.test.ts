// Names in an agent's view: ids, labels and values, read together with collisions refused or noted.
import { describe, expect, test } from "bun:test";
import { labelled, NameRefusal, resolveNames, type ViewNames } from "../src/bun/agent/names";

/** A task screen where the id `status` (Workflow) collides with a label filter named Status. */
const names: ViewNames = {
	filters: [
		{ id: "status", label: "Workflow", options: [{ value: "inbox", label: "Inbox" }, { value: "archived", label: "Archived" }] },
		{ id: "label:3", label: "Status", options: [{ value: "High", label: "High" }, { value: "Blocked", label: "Blocked" }] },
		{ id: "label:1", label: "Project", options: [{ value: "p1", label: "Home" }, { value: "p2", label: "Home" }, { value: "__none", label: "No project" }] },
		{ id: "due", label: "Due", options: null },
	],
	controls: [{ id: "range", label: "Period", options: [{ value: "7d", label: "Last week" }] }],
	tables: [{ id: "tasks", columns: [{ key: "due", title: "Due date" }, { key: "name", title: "Task" }] }],
};
const refusal = (view: Parameters<typeof resolveNames>[0]) => {
	try {
		resolveNames(view, names);
	} catch (error) {
		expect(error).toBeInstanceOf(NameRefusal);
		return (error as Error).message;
	}
	throw new Error("expected a refusal");
};

describe("names in an agent's view", () => {
	test("ids and values pass unchanged, with nothing to say", () => {
		expect(resolveNames({ search: "x", filters: { status: ["archived"] }, sort: { tasks: "-due" }, controls: { range: "7d" } }, names)).toEqual({
			view: { search: "x", filters: { status: ["archived"] }, sort: { tasks: "-due" }, controls: { range: "7d" } },
			notes: [],
		});
	});

	test("labels in any case become ids and values, and the result says how they were read", () => {
		const r = resolveNames({ filters: { workflow: ["ARCHIVED"], " project ": ["no project"] }, sort: { Tasks: "-Due date" }, controls: { period: "last week" } }, names);
		expect(r.view).toEqual({ filters: { status: ["archived"], "label:1": ["__none"] }, sort: { tasks: "-due" }, controls: { range: "7d" } });
		expect(r.notes).toEqual(['Names read as: filters {"status": ["archived"], "label:1": ["__none"]}; controls {"range": "7d"}; sort {"tasks": "-due"}.']);
	});

	test("a key and its values are read together: the filter offering the values is the one meant", () => {
		// `status` is Workflow's id, but only the filter named Status offers Blocked.
		expect(resolveNames({ filters: { status: ["blocked"] } }, names)).toEqual({ view: { filters: { "label:3": ["Blocked"] } }, notes: ['Names read as: filters {"label:3": ["Blocked"]}.'] });
		// Both fit (all): the exact id wins, and the other filter is named.
		expect(resolveNames({ filters: { status: [] } }, names)).toEqual({
			view: { filters: { status: [] } },
			notes: ['"status" is the id of Workflow [status]; Status [label:3] is a different filter.'],
		});
		// No exact id among several fits: refused with the candidates.
		expect(refusal({ filters: { STATUS: [] } })).toBe('"STATUS" names more than one filter: Workflow [status], Status [label:3]. Pass the id in brackets.');
		// None fits: each candidate's options.
		expect(refusal({ filters: { STATUS: ["nope"] } })).toBe('"STATUS" could be Workflow [status] or Status [label:3], and none of them offers "nope". Workflow [status]: Inbox, Archived; Status [label:3]: High, Blocked.');
		expect(refusal({ filters: { status: ["nope"] } })).toBe('Filter Workflow [status] has no option "nope". Its options: Inbox, Archived.');
	});

	test("an option label shared by two options, or one filter named twice, is refused", () => {
		expect(refusal({ filters: { project: ["home"] } })).toBe('"home" names more than one option of Project [label:1]: Home [p1], Home [p2]. Pass the value in brackets.');
		expect(resolveNames({ filters: { project: ["p2"] } }, names).view).toEqual({ filters: { "label:1": ["p2"] } });
		expect(refusal({ filters: { workflow: ["inbox"], status: ["inbox"] } })).toBe('"workflow" and "status" both name the filter Workflow [status]; pass it once.');
	});

	test("names that match nothing, options not rendered yet and malformed values are left for the screen's checks", () => {
		expect(resolveNames({ filters: { colour: ["red"], due: ["Today"], workflow: "inbox" as unknown as string[] }, sort: { tasks: "-size", other: "x" } }, names).view).toEqual({
			filters: { colour: ["red"], due: ["Today"], status: "inbox" },
			sort: { tasks: "-size", other: "x" },
		});
	});

	test("labels show their id only when it differs beyond case", () => {
		expect(labelled("Status", "status")).toBe("Status");
		expect(labelled("Workflow", "workflow-state")).toBe("Workflow [workflow-state]");
	});
});
