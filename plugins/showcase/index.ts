// Showcase: every node type, and a table of N rows that all change every second — the
// renderer's stress test. N is adjustable on the Components screen.
import { definePlugin, type Row, type Tone } from "../../src/sdk";

const names = ["api", "web", "worker", "scheduler", "search", "mailer", "billing", "auth", "cache", "gateway", "metrics", "uploads"];
const regions = ["eu-west", "us-east", "ap-south"];
let rowCount = 500;
let tick = 0;
let query = "";
let paused = false;

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

const visible = () => jobs.filter((j) => !query || j.name.includes(query) || j.region.includes(query));

const ctx = definePlugin({
	start(ctx) {
		ensureJobs();
		setInterval(() => {
			if (paused) return;
			step();
			ctx.invalidate("screen:table", "quick");
			ctx.badge(jobs.filter((j) => j.status === "danger").length || null);
		}, 1000);
	},
	render: {
		"screen:table": () => {
			const rows: Row[] = visible().map((j) => ({
				id: j.id,
				group: j.region,
				cells: {
					name: { text: j.name, sub: j.id, dot: j.status },
					cpu: { text: `${j.cpu.toFixed(1)}%`, tone: j.status === "success" ? "default" : j.status },
					mem: `${j.mem.toFixed(0)} MB`,
					uptime: ago(Date.now() - j.started),
					tags: { text: "", chips: [j.region, j.cpu > 60 ? "hot" : "ok"] },
				},
				details: [
					{ label: "ID", value: j.id, mono: true },
					{ label: "Region", value: j.region },
					{ label: "CPU", value: `${j.cpu.toFixed(2)}%` },
					{ label: "Memory", value: `${j.mem.toFixed(1)} MB` },
					{ label: "Started", value: new Date(j.started).toLocaleString() },
				],
			}));
			return {
				type: "page",
				search: { placeholder: "Filter jobs…" },
				summary: `${rows.length} jobs · tick ${tick}`,
				actions: [{ id: paused ? "resume" : "pause", label: paused ? "Resume" : "Pause", icon: paused ? "play" : "pause" }],
				children: [
					{
						type: "table",
						id: "jobs",
						columns: [
							{ key: "name", title: "Job", grow: true },
							{ key: "tags", title: "Tags", optional: true },
							{ key: "cpu", title: "CPU", align: "right", mono: true },
							{ key: "mem", title: "Memory", align: "right", mono: true, optional: true },
							{ key: "uptime", title: "Uptime", align: "right", mono: true },
						],
						rows,
						actions: [
							{ id: "restart", label: "Restart", icon: "rotate-cw", inline: true },
							{ id: "stop", label: "Stop", icon: "square", tone: "destructive", confirm: "Stop this job?" },
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
						items: hot.map((j) => ({ id: j.id, title: j.name, subtitle: j.region, dot: j.status, meta: `${j.cpu.toFixed(0)}%`, actions: [{ id: "restart", label: "Restart", icon: "rotate-cw" }] })),
					},
				],
			};
		},
	},
	onEvent(surface, name, payload, ctx) {
		if (name === "search") query = String(payload?.query ?? "").toLowerCase();
		else if (name === "pause" || name === "resume") paused = name === "pause";
		else if (name === "field" && payload?.field === "rows") {
			rowCount = Number(payload.value);
			ensureJobs();
		} else if (name === "field" && payload?.field === "paused") paused = !!payload.value;
		else if (name === "restart" || name === "stop") {
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
