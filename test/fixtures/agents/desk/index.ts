// Agent scenario fixture (test/agent-scenarios): a task list shaped like the trees real task
// plugins render. Sections with sub-sections and an empty one, nested rows, row panes with an
// inline form and a timeline, a filter with a default, search with a highlight, a sortable
// column and a dialog. Search, the Status filter and the sort are SDK-owned views (each
// instance has its own); the dialog is per instance too. Events: `settle` ({ rowId }), `reopen-all`,
// `new-task` opens the sender's dialog and `dialog-close` closes it. Times are fixed around
// clock.ts's NOW.
import type { Node, Row } from "../../../../src/shared/protocol";
import { definePlugin, type View } from "../../../../src/sdk";
import { DAY, HOUR, MIN, NOW } from "../clock";

type Task = {
	id: string;
	title: string;
	section: string;
	due?: number;
	project: string;
	status: string;
	dot?: string;
	unread?: boolean;
	details?: { label: string; value: string }[];
	history?: { id: string; at: number; text: string; title?: string }[];
	children?: Task[];
};

const tasks: Task[] = [
	{ id: "1", title: "Submit November expense report", section: "overdue", due: NOW - 2 * DAY, project: "Finance", status: "Todo", dot: "overdue", unread: true },
	{
		id: "2",
		title: "Q4 budget review with finance",
		section: "today",
		due: NOW + 5 * HOUR,
		project: "Finance",
		status: "Working",
		dot: "stalled",
		history: [
			{ id: "h2", at: NOW - DAY, text: "Waiting for the headcount figures from HR before the meeting." },
			{ id: "h1", at: NOW - 4 * DAY, title: "Moved to Working", text: "Sent the draft numbers to Maria." },
		],
		children: [{ id: "3", title: "Draft budget slides", section: "today", project: "Finance", status: "Todo", dot: "stalled" }],
	},
	{ id: "4", title: "Migrate CI to the new runners", section: "this-week", due: NOW + 2 * DAY, project: "ToolBelt", status: "Working", details: [{ label: "Related", value: "Blocks: #5" }] },
	{ id: "5", title: "Fix flaky remote-access test", section: "this-week", due: NOW + 3 * DAY, project: "ToolBelt", status: "Blocked", dot: "blocked" },
	{ id: "6", title: "Renew passport", section: "later", due: NOW + 9 * DAY, project: "Home", status: "Todo" },
	{ id: "7", title: "Plan team offsite agenda", section: "later", due: NOW + 12 * DAY, project: "Team", status: "Todo" },
	{
		id: "8",
		title: "Quote for the office printers",
		section: "waiting",
		due: NOW + 15 * HOUR + 24 * MIN,
		project: "Office",
		status: "Waiting",
		details: [{ label: "Waiting on", value: "Acme\n(asked a week ago, watching weekly)" }],
	},
];

/** Instances with the New task dialog open. */
const dialogs = new Set<string>();
const settled = new Map<string, string>();

const matches = (query: string) => (t: Task): boolean =>
	!query || `${t.title} ${t.project}`.toLowerCase().includes(query.toLowerCase()) || (t.children ?? []).some(matches(query));

function row(t: Task): Row {
	const pane: Node[] | undefined = t.history
		? [
				{
					type: "form",
					id: `task-${t.id}`,
					appearance: "inline",
					fields: [
						{ type: "text", id: "title", label: "", value: t.title, heading: true, note: `#${t.id}` },
						{ type: "select", id: "status", label: "Status", value: t.status.toLowerCase(), options: ["Todo", "Working", "Waiting", "Blocked"].map((s) => ({ value: s.toLowerCase(), label: s })) },
						{ type: "tags", id: "labels", label: "Labels", value: [{ key: "area", value: t.project }], keys: [{ key: "area", label: "Area" }] },
					],
				},
				{ type: "timeline", id: `history-${t.id}`, entries: t.history.map((h) => ({ ...h, author: "you" })) },
			]
		: undefined;
	return {
		id: t.id,
		group: settled.has(t.id) ? "done" : t.section,
		unread: t.unread,
		dot: t.dot ? { color: t.dot === "overdue" ? "danger" : "warning", label: t.dot } : undefined,
		cells: {
			title: { text: t.title, prefix: { text: `#${t.id}` } },
			due: t.due ? { text: "", at: t.due } : "",
			project: { text: t.project, tags: [{ text: t.status }] },
		},
		details: t.details,
		pane,
		children: t.children?.map(row),
	};
}

function tasksPage(view: View): Node {
	const query = view.search;
	const statusFilter = view.filters.status ?? [];
	const sort = view.sort.tasks;
	const visible = tasks
		.filter(matches(query))
		.filter((t) => statusFilter.includes(settled.has(t.id) ? "done" : t.section === "waiting" ? "waiting" : "open") || !statusFilter.length)
		.sort((a, b) => (sort?.key === "title" ? a.title.localeCompare(b.title) * (sort.desc ? -1 : 1) : 0));
	return {
		type: "page",
		search: { placeholder: "Search tasks" },
		summary: `${tasks.length - settled.size} open · 1 overdue`,
		filters: [
			{
				id: "status",
				label: "Status",
				options: [
					{ value: "open", label: "Open", count: 6 },
					{ value: "waiting", label: "Waiting", count: 1 },
					{ value: "done", label: "Done", count: settled.size },
				],
				selected: statusFilter,
				default: { values: ["open", "waiting"], label: "Ongoing" },
			},
		],
		highlight: query ? [query] : undefined,
		actions: [{ id: "new-task", label: "New task", primary: true }, { id: "refresh", label: "Refresh" }, { id: "archive", label: "Archive done", disabled: true }, { id: "reopen-all", label: "Reopen all" }],
		children: [
			{
				type: "table",
				id: "tasks",
				columns: [{ key: "title", title: "Task", sortable: true }, { key: "due", title: "Due" }, { key: "project", title: "Project" }],
				actions: [{ id: "settle", label: "Settle" }, { id: "snooze", label: "Snooze" }, { id: "settle", label: "Settle", inline: true }],
				bulkActions: [{ id: "settle-all", label: "Settle selected" }],
				sections: [
					{ id: "overdue", label: "Overdue" },
					{ id: "today", label: "Today" },
					{ id: "upcoming", label: "Upcoming", sections: [{ id: "this-week", label: "This week" }, { id: "later", label: "Later" }] },
					{ id: "waiting", label: "Waiting on others" },
					{ id: "snoozed", label: "Snoozed", empty: "Nothing snoozed" },
					{ id: "done", label: "Done" },
				],
				rows: visible.map(row),
			},
		],
		dialog: dialogs.has(view.instance)
			? {
					id: "new-task",
					title: "New task",
					children: [{ type: "form", id: "new", fields: [{ type: "text", id: "title", label: "Title", value: "" }] }],
					actions: [{ id: "create", label: "Create", primary: true }],
				}
			: undefined,
	};
}

definePlugin({
	start: (ctx) => ctx.badge(1),
	views: { "screen:tasks": { search: true, filters: { status: ["open", "waiting"] }, sort: { tasks: null } } },
	render: {
		"screen:tasks": (_ctx, view) => tasksPage(view),
		"screen:settings": () => ({
			type: "form",
			id: "settings",
			title: "Desk settings",
			fields: [
				{ type: "switch", id: "stall", label: "Mark stalled tasks", value: true, description: "After 3 days without activity" },
				{ type: "select", id: "week", label: "Week starts on", value: "mon", options: [{ value: "mon", label: "Monday" }, { value: "sun", label: "Sunday" }] },
			],
		}),
	},
	onEvent(_surface, name, payload, ctx, { instance }) {
		if (name === "settle") settled.set(payload.rowId, "done");
		else if (name === "reopen-all") settled.clear();
		else if (name === "new-task") dialogs.add(instance);
		else if (name === "dialog-close") dialogs.delete(instance);
		ctx.invalidate();
	},
});
