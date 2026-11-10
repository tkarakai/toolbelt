// Showcase: every node type, and a table of N rows that all change every second — the
// renderer's stress test. N is adjustable on the Components screen. The Tasks screen has the
// nodes for long-running work: cards, progress, logs, markdown and a dialog.
import { definePlugin, search, type LogLine, type Node, type Row, type Tone } from "../../src/sdk";

const names = ["api", "web", "worker", "scheduler", "search", "mailer", "billing", "auth", "cache", "gateway", "metrics", "uploads"];
const regions = ["eu-west", "us-east", "ap-south"];
let rowCount = 500;
let tick = 0;
let query = "";
let paused = false;
let nextTickAt = Date.now() + 1000;

// Tasks screen: a fake build that logs a line per second and restarts when done.
const log: LogLine[] = [];
let buildStarted = Date.now();
let dialogOpen = false;
const steps = ["Resolving packages", "Downloading", "Verifying checksums", "Compiling", "Linking", "Running tests", "Done"];
function stepBuild() {
	const i = Math.floor((Date.now() - buildStarted) / 1000);
	if (i >= 30) {
		buildStarted = Date.now();
		log.length = 0;
		return;
	}
	const step = steps[Math.min(steps.length - 1, Math.floor(i / 5))];
	log.push({ at: Date.now(), text: `${step}… (${i + 1}/30)`, tone: i % 11 === 10 ? "warning" : undefined });
}
const notes = `## 2.0.0

**Breaking:** the \`legacy\` flag is gone.

- Faster startup ([#120](https://github.com/tkarakai/toolbelt))
- New \`log\` component
  - follows the newest line
  - stops following when you scroll up

## 1.9.2

1. Fixed a crash on wake
2. Smaller download

> Upgrading from 1.x? Read the migration guide first.

| Platform | Status |
|---|---|
| macOS 15 | ✅ |
| macOS 14 | ✅ |`;

type Job = { id: string; name: string; region: string; cpu: number; mem: number; status: Tone; started: number };
const jobs: Job[] = [];
function ensureJobs() {
	while (jobs.length < rowCount) {
		const i = jobs.length;
		jobs.push({ id: `job-${i}`, name: `${names[i % names.length]}-${Math.floor(i / names.length) + 1}`, region: regions[i % regions.length], cpu: Math.random() * 40, mem: 50 + Math.random() * 900, status: "success", started: Date.now() - Math.random() * 86_400_000 });
	}
	jobs.length = rowCount;
}

function step() {
	tick++;
	for (const j of jobs) {
		j.cpu = Math.max(0, Math.min(100, j.cpu + (Math.random() - 0.5) * 12));
		j.mem = Math.max(20, j.mem + (Math.random() - 0.5) * 20);
		j.status = j.cpu > 85 ? "danger" : j.cpu > 60 ? "warning" : "success";
	}
}

const ago = (ms: number) => {
	const s = Math.floor(ms / 1000);
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// The table's sort (sortable column headers send `sort`) and the toolbar switch.
let sort = { key: "cpu", desc: true };
let showReplicas = true;
let peekOpen = false;
let peekView = "terminal";
const ESC = "\x1b[";
const termLines = () => [
	`${ESC}1;32m✓${ESC}0m Compiled ${ESC}1m42 modules${ESC}0m in 812 ms`,
	`${ESC}33mwarning${ESC}0m: this line is long on purpose, so the terminal wraps it to the width of the view and re-wraps it when you resize the dialog — no hard line breaks were sent.`,
	`${ESC}36minfo${ESC}0m  listening on ${ESC}4mhttp://localhost:5173${ESC}0m`,
	...log.map((l) => `${ESC}2m${new Date(l.at ?? Date.now()).toLocaleTimeString()}${ESC}0m ${l.text}`),
];

let lastSearch = search("");
const visible = () => {
	lastSearch = search(query);
	return jobs.filter((j) => lastSearch.test([j.name, j.id, j.region, j.cpu > 60 ? "hot" : "ok"]));
};

const ctx = definePlugin({
	start(ctx) {
		ensureJobs();
		setInterval(() => {
			if (paused) return;
			step();
			stepBuild();
			nextTickAt = Date.now() + 1000;
			ctx.invalidate("screen:table", "screen:tasks", "quick");
			ctx.badge(jobs.filter((j) => j.status === "danger").length || null);
		}, 1000);
	},
	render: {
		"screen:table": () => {
			const key = (j: Job) => (sort.key === "name" ? j.name : sort.key === "mem" ? j.mem : sort.key === "uptime" ? -j.started : j.cpu);
			const sorted = [...visible()].sort((a, b) => {
				const x = key(a), y = key(b);
				const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
				return sort.desc ? -c : c;
			});
			const rows: Row[] = sorted.map((j) => ({
				id: j.id,
				group: j.region,
				cells: {
					name: { text: j.name, sub: j.id, dot: j.status },
					cpu: { text: `${j.cpu.toFixed(1)}%`, tone: j.status === "success" ? "default" : j.status },
					mem: `${j.mem.toFixed(0)} MB`,
					uptime: ago(Date.now() - j.started),
					started: { text: "", at: j.started, tone: "muted" },
					tags: { text: "", chips: [j.region, j.cpu > 60 ? "hot" : "ok"] },
				},
				// API jobs run replicas: nested rows the person can expand.
				children: showReplicas && j.name.startsWith("api")
					? [1, 2].map((n) => ({
							id: `${j.id}-r${n}`,
							cells: { name: { text: `replica ${n}`, sub: `${j.id}-r${n}`, dot: j.status }, cpu: `${(j.cpu / 2).toFixed(1)}%`, mem: `${(j.mem / 2).toFixed(0)} MB`, uptime: ago(Date.now() - j.started) },
							actions: ["restart"],
							details: [{ label: "Replica of", value: j.name }],
						}))
					: undefined,
				stats: [
					{ label: "CPU", value: `${j.cpu.toFixed(1)}%`, tone: j.status === "success" ? undefined : j.status },
					{ label: "Memory", value: `${j.mem.toFixed(0)} MB` },
				],
				details: [
					{ section: "Job", label: "ID", value: j.id, mono: true },
					{ section: "Job", label: "Region", value: j.region },
					{ section: "Timing", label: "Started", value: new Date(j.started).toLocaleString() },
				],
			}));
			return {
				type: "page",
				search: { placeholder: "Filter jobs…" },
				summary: `${rows.length} jobs · tick ${tick}`,
				highlight: lastSearch.highlight(),
				actions: [
					{ id: "toggle-replicas", label: "Replicas", checked: showReplicas },
					{ id: paused ? "resume" : "pause", label: paused ? "Resume" : "Pause", icon: paused ? "play" : "pause" },
				],
				dialog: peekOpen
					? {
							id: "peek",
							title: "Peek — build",
							description: "A resizable dialog: drag an edge, or maximize it",
							wide: true,
							resizable: true,
							children: [
								{ type: "segmented", id: "peek-view", value: peekView, options: [{ value: "terminal", label: "Terminal", icon: "square-terminal" }, { value: "conversation", label: "Conversation", icon: "messages-square" }] },
								peekView === "terminal"
									? { type: "terminal", id: "peek-term", lines: termLines(), follow: true }
									: {
											type: "conversation",
											id: "peek-chat",
											messages: [
												{ role: "user", author: "You", text: "Why is the build slow?" },
												{ role: "tool", text: "bun run build --profile", tool: { name: "Bash", detail: '{ "command": "bun run build --profile" }' } },
												{ role: "tool", text: "build/profile.json", tool: { name: "Read" } },
												{ role: "assistant", author: "agent", text: "Most of the time goes to **type checking**. Try:\n\n```sh\nbun run build --no-typecheck\n```" },
											],
										},
							],
						}
					: undefined,
				children: [
					{
						type: "table",
						id: "jobs",
						// Narrow windows hide columns from the right (Started first); Job always stays.
						columns: [
							{ key: "name", title: "Job", grow: true, sortable: true },
							{ key: "tags", title: "Tags" },
							{ key: "cpu", title: "CPU", align: "right", mono: true, sortable: true, sortDesc: true },
							{ key: "mem", title: "Memory", align: "right", mono: true, sortable: true, sortDesc: true },
							{ key: "uptime", title: "Uptime", align: "right", mono: true, sortable: true, sortDesc: true },
							{ key: "started", title: "Started", align: "right" },
						],
						sort,
						rows,
						actions: [
							{ id: "restart", label: "Restart", icon: "rotate-cw", inline: true, group: "run" },
							{ id: "peek", label: "Peek", icon: "scan-eye", inline: true, group: "run" },
							{ id: "copy-id", label: "Copy ID", icon: "copy", group: "copy" },
							{ id: "stop", label: "Stop", icon: "square", tone: "destructive", group: "stop", confirm: "Stop this job?" },
						],
						bulkActions: [
							{ id: "restart-many", label: "Restart", icon: "rotate-cw" },
							{ id: "stop-many", label: "Stop", icon: "square", tone: "destructive", confirm: "Stop the selected jobs?" },
						],
						empty: { title: "No jobs match", description: "Try a different filter.", icon: "search-x" },
					},
				],
			};
		},
		"screen:components": () => ({
			type: "page",
			summary: "The node types a plugin can use",
			children: [
				{
					type: "stats",
					items: [
						{ label: "Jobs", value: String(jobs.length), hint: "in the live table" },
						{ label: "Hot", value: String(jobs.filter((j) => j.cpu > 60).length), hint: "over 60% CPU" },
						{ label: "Ticks", value: String(tick) },
						{ label: "Next tick", value: "", at: nextTickAt, hint: "a relative time, drawn by Toolbelt" },
					],
				},
				{
					type: "form",
					id: "settings",
					title: "Live table",
					description: "Settings forms are plugin-described too.",
					fields: [
						{ type: "select", id: "rows", label: "Rows", value: String(rowCount), options: ["50", "200", "500", "1000", "2000"].map((v) => ({ value: v, label: `${v} rows` })), description: "How many rows change every second." },
						{ type: "switch", id: "paused", label: "Paused", value: paused, description: "Stop the updates." },
					],
				},
				{
					type: "list",
					id: "recent",
					items: jobs.slice(0, 4).map((j) => ({ id: j.id, title: j.name, subtitle: j.region, dot: j.status, meta: `${j.cpu.toFixed(0)}%` })),
				},
				{ type: "text", text: "Text, in a muted tone, for notes and explanations.", tone: "muted" },
			],
		}),
		"screen:tasks": (): Node => {
			const elapsed = (Date.now() - buildStarted) / 30_000;
			return {
				type: "page",
				summary: "Long-running work",
				actions: [{ id: "open-dialog", label: "Review release", icon: "file-text", primary: true }],
				children: [
					{
						type: "card",
						id: "build",
						title: "Building toolbelt-demo",
						description: "A card with actions, details, progress and a log that follows the newest line.",
						actions: [{ id: "restart-build", label: "Restart", icon: "rotate-cw" }],
						children: [
							{ type: "details", items: [{ label: "Command", value: "bun run build", mono: true }, { label: "Folder", value: "~/dev/demo", mono: true }, { label: "Status", value: "Running", tone: "info" }] },
							{ type: "progress", label: steps[Math.min(steps.length - 1, Math.floor(elapsed * 6))], value: Math.min(1, elapsed), at: buildStarted },
							{ type: "log", id: "build-log", lines: log, follow: true, empty: "Waiting for output…" },
						],
					},
					{ type: "card", title: "Waiting for something", tone: "warning", children: [{ type: "progress", label: "Working… (no value: indeterminate)", at: buildStarted }] },
					{ type: "card", title: "Release notes", description: "Markdown: headings, lists, links, code, quotes, tables", children: [{ type: "markdown", text: notes }] },
				],
				dialog: dialogOpen
					? {
							id: "review",
							title: "Update demo 1.9.1 → 2.0.0",
							description: "A plugin-driven dialog: content and buttons come from the plugin.",
							wide: true,
							children: [
								{ type: "text", text: "Version 2.0.0 is a major update and may change how it works.", tone: "warning" },
								{ type: "card", title: "What will run", children: [{ type: "log", id: "cmd", lines: [{ text: "$ brew upgrade demo" }] }] },
								{ type: "markdown", text: notes },
							],
							actions: [
								{ id: "skip", label: "Skip this version" },
								{ id: "update", label: "Update now", icon: "download", primary: true },
							],
						}
					: undefined,
			};
		},
		quick: () => {
			const hot = [...jobs].sort((a, b) => b.cpu - a.cpu).slice(0, 6);
			return {
				type: "stack",
				gap: 3,
				children: [
					{ type: "stats", items: [{ label: "Jobs", value: String(jobs.length) }, { label: "Hot", value: String(jobs.filter((j) => j.cpu > 60).length) }] },
					{
						type: "list",
						id: "hot",
						items: hot.map((j) => ({ id: j.id, title: j.name, subtitle: `${j.region} · ${j.cpu.toFixed(0)}%`, dot: j.status, metaAt: j.started, actions: [{ id: "restart", label: "Restart", icon: "rotate-cw" }] })),
					},
				],
			};
		},
	},
	onEvent(surface, name, payload, ctx) {
		if (name === "search") query = String(payload?.query ?? "").toLowerCase();
		else if (name === "sort") sort = { key: String(payload?.key), desc: !!payload?.desc };
		else if (name === "toggle-replicas") showReplicas = !showReplicas;
		else if (name === "peek") peekOpen = true;
		else if (name === "dialog-close" && payload?.dialog === "peek") peekOpen = false;
		else if (name === "field" && payload?.form === "peek-view") peekView = String(payload.value);
		else if (name === "copy-id") {
			ctx.copy(String(payload?.rowId));
			ctx.toast("Copied", "success");
		}
		else if (name === "pause" || name === "resume") paused = name === "pause";
		else if (name === "field" && payload?.field === "rows") {
			rowCount = Number(payload.value);
			ensureJobs();
		} else if (name === "field" && payload?.field === "paused") paused = !!payload.value;
		else if (name === "restart-many" || name === "stop-many") {
			const ids: string[] = payload?.rowIds ?? [];
			for (const j of jobs) if (ids.includes(j.id) && name === "restart-many") j.started = Date.now();
			ctx.toast(`${name === "restart-many" ? "Restarted" : "Stopped"} ${ids.length} jobs`, "success");
		} else if (name === "open-dialog") dialogOpen = true;
		else if (name === "dialog-close") dialogOpen = false;
		else if (name === "update" || name === "skip") {
			dialogOpen = false;
			ctx.toast(name === "update" ? "Updating (not really)" : "Skipped 2.0.0", "success");
		} else if (name === "restart-build") {
			buildStarted = Date.now();
			log.length = 0;
		} else if (name === "restart" || name === "stop") {
			const j = jobs.find((x) => x.id === payload?.rowId);
			if (j) {
				if (name === "restart") j.started = Date.now();
				ctx.toast(`${name === "restart" ? "Restarted" : "Stopped"} ${j.name}`, "success");
			}
		}
		void surface;
		ctx.invalidate();
	},
});
void ctx;
