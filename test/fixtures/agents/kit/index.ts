// Agent scenario fixture (test/agent-scenarios): software updates shaped like the trees real
// update plugins render (status sections, split actions, nested activity runs with details), a
// connection form with a sensitive field and secret environment entries, and long tables for
// paging. Times are fixed around clock.ts's NOW.
import type { Node, Row } from "../../../../src/shared/protocol";
import { definePlugin } from "../../../../src/sdk";
import { HOUR, MIN, NOW } from "../clock";

// Fake values: scenarios check that agents never see them.
const TOKEN = "tb_live_9f8e7d6c5b4a"; // gitleaks:allow
const API_KEY = "sk-proj-kit-abc123secret"; // gitleaks:allow

const update = (id: string, name: string, current: string, latest: string, group: string, extra: Partial<Row> = {}): Row => ({
	id,
	group,
	cells: { name, version: current === latest ? current : `${current} → ${latest}`, source: { text: "custom recipe", tags: [{ text: "review first" }] } },
	...extra,
});

const updates = (): Node => ({
	type: "page",
	summary: "5 items · 2 updates",
	actions: [{ id: "check", label: "Check now" }],
	children: [
		{
			type: "table",
			id: "updates",
			columns: [{ key: "name", title: "Item" }, { key: "version", title: "Version" }, { key: "source", title: "Source" }],
			actions: [{ id: "update", label: "Update", menu: [{ id: "review", label: "Review & update…" }] }, { id: "pin", label: "Hold back" }],
			bulkActions: [{ id: "update-all", label: "Update selected" }],
			sections: [
				{ id: "needs-you", label: "Needs you" },
				{ id: "review", label: "Review first" },
				{ id: "current", label: "Up to date" },
				{ id: "held", label: "Held back" },
			],
			rows: [
				update("deploy-cli", "Internal deploy CLI", "2.3.0", "2.3.0", "needs-you", {
					dot: { color: "danger", label: "check failed" },
					details: [{ label: "Error", value: "The newest-version command exited with code 3." }],
				}),
				update("ollama", "Ollama", "0.5.1", "0.6.2", "review", { unread: true, details: [{ label: "Found", value: "Today's scheduled check" }] }),
				update("node", "Node.js LTS", "22.11.0", "24.1.0", "review"),
				update("terraform", "Terraform", "1.9.8", "1.9.8", "current"),
				update("postgres", "Postgres.app", "16.4", "17.2", "held", { details: [{ label: "Pinned", value: "Stays on 16.4" }] }),
			],
		},
	],
});

const activity = (): Node => ({
	type: "table",
	id: "runs",
	columns: [{ key: "what", title: "Run" }, { key: "when", title: "When" }],
	rows: [
		{
			id: "run-1",
			cells: { what: "Scheduled check: 5 items, 2 new updates, 1 failed", when: { text: "", at: NOW - 3 * HOUR } },
			details: [{ label: "Log", value: "~/Library/Logs/kit/run-1.log" }],
			children: [
				{ id: "run-1-ollama", cells: { what: "Ollama: 0.6.2 found", when: { text: "", at: NOW - 3 * HOUR } } },
				{ id: "run-1-node", cells: { what: "Node.js LTS: 24.1.0 found", when: { text: "", at: NOW - 3 * HOUR } } },
				{ id: "run-1-deploy", cells: { what: { text: "Internal deploy CLI: check failed (exit 3)", dot: { color: "danger", label: "failed" } }, when: { text: "", at: NOW - 3 * HOUR + MIN } } },
			],
		},
	],
});

const connection = (): Node => ({
	type: "page",
	children: [
		{ type: "stats", items: [{ label: "Last sync", value: "", at: NOW - 20 * MIN }, { label: "Status", value: "Connected", tone: "success" }] },
		{
			type: "form",
			id: "connection",
			title: "Connection",
			fields: [
				{ type: "text", id: "server", label: "Server", value: "registry.example.test" },
				{ type: "text", id: "token", label: "Token", value: TOKEN, sensitive: true },
				{
					type: "environment",
					id: "env",
					label: "Environment",
					value: [
						{ key: "API_KEY", value: API_KEY, selected: true, secret: true },
						{ key: "REGION", value: "eu-west-1", selected: true, secret: false },
					],
				},
				{ type: "switch", id: "auto", label: "Check automatically", value: true },
			],
		},
	],
});

const queue = (): Node => ({
	type: "stack",
	children: [
		{
			type: "table",
			id: "jobs",
			columns: [{ key: "name", title: "Job" }, { key: "state", title: "State" }],
			rows: Array.from({ length: 250 }, (_, i) => ({ id: `job-${i + 1}`, cells: { name: `Job ${String(i + 1).padStart(3, "0")}`, state: i < 3 ? "running" : "queued" } })),
		},
		{
			type: "table",
			id: "workers",
			columns: [{ key: "name", title: "Worker" }],
			rows: ["alpha", "beta", "gamma"].map((name) => ({ id: name, cells: { name: `Worker ${name}` } })),
		},
	],
});

definePlugin({
	start: (ctx) => ctx.badge(2),
	render: { "screen:updates": updates, "screen:activity": activity, "screen:connection": connection, "screen:queue": queue },
});
