// Processes (spike): a Toolbelt plugin that drives the existing `running-core`
// (src/serve.ts in github.com/tkarakai/running) over its own JSON-lines protocol and turns
// its snapshots into Toolbelt UI trees. toolbelt-ps will replace this with a native plugin.
//
// Where running is: RUNNING_CORE_SCRIPT, else ~/dev/projects/running/src/serve.ts.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { definePlugin, type Context, type Node, type Row, type Tone } from "../../src/sdk";

const script = process.env.RUNNING_CORE_SCRIPT ?? `${homedir()}/dev/projects/running/src/serve.ts`;

// ── running-core client ──────────────────────────────────────────────────
type Listen = { pid: number; port: number; host: string };
type ProcRow = {
	pid: number; kind: string; command: string; argvCommand: string; displayArgv: string[]; cwd: string; listen: Listen[];
	where: string; termLabel: string; tty: string; stat: string; etimeSec: number; rssKb: number; cpu: number; pidCount: number;
	exe?: string; source: string; keptIndex?: number; agent?: { harness: string; title?: string };
	members: Member[];
};
type Member = { pid: number; ppid: number; depth: number; displayArgv: string[]; argvCommand: string; cwd: string; listen: Listen[]; tty: string; stat: string; etimeSec: number; rssKb: number; cpu: number; pidCount: number };
type KeptDTO = { index: number; name?: string; command: string; cwd: string; note: string; ports: number[]; line: string; livePid?: number };
type Probe = { pid: number; port: number; pending: boolean; web?: boolean; url?: string; title?: string };
type Snapshot = { at: number; rows: ProcRow[]; kept: KeptDTO[]; probes: Probe[]; branches: Record<string, string | null>; sort: { key: string; desc: boolean } };
type Hello = { version: string; sorts: Record<string, { label: string }>; terminals: Record<string, unknown> };

let core: ReturnType<typeof Bun.spawn> | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let coreError: string | null = existsSync(script) ? null : `running-core not found at ${script}`;

function startCore() {
	if (coreError) return;
	core = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
	void (async () => {
		const decoder = new TextDecoder();
		let buf = "";
		for await (const chunk of core!.stdout as ReadableStream<Uint8Array>) {
			buf += decoder.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (msg.event === "changed") void refresh();
				if (typeof msg.id === "number" && waiting.has(msg.id) && !msg.event) {
					const w = waiting.get(msg.id)!;
					waiting.delete(msg.id);
					msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.result);
				}
			}
		}
	})();
	void core.exited.then((code) => {
		coreError = `running-core exited (${code})`;
		ctx.invalidate();
	});
}

function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	if (!core) return Promise.reject(new Error(coreError ?? "running-core isn't running"));
	const id = nextId++;
	const sink = core.stdin as import("bun").FileSink;
	sink.write(JSON.stringify({ id, method, params }) + "\n");
	sink.flush();
	return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

// ── state ────────────────────────────────────────────────────────────────
let snap: Snapshot | null = null;
let hello: Hello | null = null;
let query = "";
let terminal = "terminal";
let refreshing = false;

async function refresh() {
	if (refreshing || !core) return;
	refreshing = true;
	try {
		snap = await call<Snapshot>("snapshot");
		ctx.badge(snap.rows.length || null);
		ctx.invalidate();
	} catch (e) {
		coreError = (e as Error).message;
		ctx.invalidate();
	} finally {
		refreshing = false;
	}
}

// ── formatting ───────────────────────────────────────────────────────────
const home = homedir();
const tildify = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);
const dur = (s: number) => (s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`);
const mem = (kb: number) => (kb > 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
const name = (r: ProcRow) => r.agent?.title || r.command || r.argvCommand;
const webUrl = (r: { listen: Listen[] }) => snap?.probes.find((p) => p.pid && r.listen.some((l) => l.pid === p.pid && l.port === p.port) && p.web)?.url;
const statusOf = (r: ProcRow): Tone => (r.listen.length ? "success" : r.stat.includes("T") ? "warning" : "info");

const matches = (r: ProcRow) => !query || `${name(r)} ${r.cwd} ${r.listen.map((l) => l.port).join(" ")} ${r.where}`.toLowerCase().includes(query);

function processRows(): Row[] {
	return (snap?.rows ?? []).filter(matches).map((r) => {
		const url = webUrl(r);
		return {
			id: String(r.pid),
			group: tildify(r.cwd) || "—",
			cells: {
				name: { text: name(r), sub: [r.agent ? r.agent.harness : r.kind, r.pidCount > 1 ? `${r.pidCount} processes` : ""].filter(Boolean).join(" · "), dot: statusOf(r), mono: !r.agent },
				ports: { text: "", chips: r.listen.map((l) => `:${l.port}`) },
				where: { text: r.termLabel || r.where || "", tone: "muted" },
				cpu: `${r.cpu.toFixed(1)}%`,
				mem: mem(r.rssKb),
				uptime: dur(r.etimeSec),
			},
			actions: ["focus", ...(url ? ["open"] : []), "stop"],
			children: memberRows(r),
			details: [
				{ label: "Command", value: r.argvCommand, mono: true },
				{ label: "Directory", value: tildify(r.cwd), mono: true },
				{ label: "PID", value: String(r.pid), mono: true },
				{ label: "Terminal", value: r.termLabel || r.where || "—" },
				{ label: "TTY", value: r.tty || "—", mono: true },
				...(url ? [{ label: "URL", value: url, mono: true }] : []),
				{ label: "CPU · Memory", value: `${r.cpu.toFixed(1)}% · ${mem(r.rssKb)}` },
				{ label: "Running for", value: dur(r.etimeSec) },
				...(snap?.branches[r.cwd] ? [{ label: "Git branch", value: snap.branches[r.cwd]!, mono: true }] : []),
			],
		};
	});
}

/** A job's other processes as nested rows, following parent → child. */
function memberRows(r: ProcRow): Row[] | undefined {
	if (!r.members.length) return undefined;
	const pids = new Set(r.members.map((m) => m.pid));
	const toRow = (m: Member): Row => {
		const url = webUrl(m);
		const kids = r.members.filter((c) => c.ppid === m.pid);
		return {
			id: String(m.pid),
			cells: {
				name: { text: m.argvCommand, sub: m.pidCount > 1 ? `pid ${m.pid} · ${m.pidCount} processes` : `pid ${m.pid}`, dot: m.listen.length ? "success" : "muted", mono: true },
				ports: { text: "", chips: m.listen.map((l) => `:${l.port}`) },
				where: { text: "" },
				cpu: `${m.cpu.toFixed(1)}%`,
				mem: mem(m.rssKb),
				uptime: dur(m.etimeSec),
			},
			actions: [...(url ? ["open"] : []), "stop"],
			details: [
				{ label: "Command", value: m.argvCommand, mono: true },
				{ label: "Directory", value: tildify(m.cwd), mono: true },
				{ label: "PID · parent", value: `${m.pid} · ${m.ppid}`, mono: true },
				...(url ? [{ label: "URL", value: url, mono: true }] : []),
				{ label: "CPU · Memory", value: `${m.cpu.toFixed(1)}% · ${mem(m.rssKb)}` },
				{ label: "Running for", value: dur(m.etimeSec) },
			],
			children: kids.length ? kids.map(toRow) : undefined,
		};
	};
	// Top level: members whose parent isn't another member (the job's direct children).
	return r.members.filter((m) => !pids.has(m.ppid)).map(toRow);
}

/** The job a pid belongs to, and the member if it isn't the job itself. */
function locate(pid: number): { row: ProcRow; member?: Member } | undefined {
	for (const row of snap?.rows ?? []) {
		if (row.pid === pid) return { row };
		const member = row.members.find((m) => m.pid === pid);
		if (member) return { row, member };
	}
}

const unavailable = (): Node => ({
	type: "empty",
	icon: "plug-zap",
	title: "running-core isn't available",
	description: `${coreError}. Set RUNNING_CORE_SCRIPT to a checkout's src/serve.ts.`,
});

// ── plugin ───────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
function schedule(c: Context) {
	if (timer) clearInterval(timer);
	// Refresh every 2 s while something is on screen, every 15 s for the badge otherwise.
	timer = setInterval(() => void refresh(), c.open.size ? 2000 : 15000);
}

const ctx = definePlugin({
	async start(c) {
		startCore();
		if (core) hello = await call<Hello>("hello").catch(() => null);
		await refresh();
		schedule(c);
	},
	onOpen: (_s, c) => {
		schedule(c);
		void refresh();
	},
	onClose: (_s, c) => schedule(c),
	render: {
		"screen:processes": () => {
			if (coreError) return unavailable();
			const rows = processRows();
			return {
				type: "page",
				search: { placeholder: "Filter by command, folder, port…" },
				summary: snap ? `${rows.length} of ${snap.rows.length} processes` : "Loading…",
				actions: [{ id: "refresh", label: "Refresh", icon: "refresh-cw" }],
				children: [
					{
						type: "table",
						id: "processes",
						columns: [
							{ key: "name", title: "Process", grow: true },
							{ key: "ports", title: "Ports" },
							{ key: "where", title: "Terminal", optional: true },
							{ key: "cpu", title: "CPU", align: "right", mono: true, optional: true },
							{ key: "mem", title: "Memory", align: "right", mono: true, optional: true },
							{ key: "uptime", title: "Up", align: "right", mono: true },
						],
						rows,
						actions: [
							{ id: "focus", label: "Show in terminal", icon: "square-terminal", inline: true },
							{ id: "open", label: "Open in browser", icon: "globe", inline: true },
							{ id: "stop", label: "Stop", icon: "square", tone: "destructive", confirm: "Stop this process (SIGTERM)?" },
						],
						empty: { title: snap ? "Nothing running" : "Loading…", description: snap ? "Processes you start in your terminals show up here." : undefined, icon: "terminal" },
					},
				],
			};
		},
		"screen:kept": () => {
			if (coreError) return unavailable();
			const kept = snap?.kept ?? [];
			return {
				type: "page",
				summary: `${kept.length} kept`,
				children: [
					{
						type: "table",
						id: "kept",
						columns: [
							{ key: "name", title: "Name", grow: true },
							{ key: "dir", title: "Directory", optional: true },
							{ key: "state", title: "State" },
						],
						rows: kept.map((k) => ({
							id: String(k.index),
							cells: {
								name: { text: k.name || k.command, sub: k.line, mono: false },
								dir: { text: tildify(k.cwd), mono: true, tone: "muted" },
								state: k.livePid ? { text: "Running", dot: "success" } : { text: "Stopped", dot: "muted", tone: "muted" },
							},
							actions: k.livePid ? [] : ["start"],
							details: [
								{ label: "Command", value: k.line, mono: true },
								{ label: "Directory", value: tildify(k.cwd), mono: true },
								...(k.note ? [{ label: "Note", value: k.note }] : []),
								...(k.ports.length ? [{ label: "Ports", value: k.ports.join(", ") }] : []),
							],
						})),
						actions: [{ id: "start", label: "Start", icon: "play", inline: true }],
						empty: { title: "Nothing kept yet", description: "Keep a process to start it again later.", icon: "bookmark" },
					},
				],
			};
		},
		"screen:settings": () => ({
			type: "page",
			children: [
				{
					type: "form",
					id: "settings",
					title: "Processes",
					description: `running-core ${hello?.version ?? "?"} · ${tildify(script)}`,
					fields: [
						{ type: "select", id: "sort", label: "Sort", value: snap?.sort.key ?? "", options: Object.entries(hello?.sorts ?? {}).map(([value, s]) => ({ value, label: s.label })), description: "How the TUI and this list order processes." },
						{ type: "select", id: "terminal", label: "Start kept processes in", value: terminal, options: Object.keys(hello?.terminals ?? { terminal: 1 }).map((t) => ({ value: t, label: t })) },
					],
				},
			],
		}),
		quick: () => {
			if (coreError) return unavailable();
			const rows = (snap?.rows ?? []).filter((r) => r.kind !== "app").sort((a, b) => b.listen.length - a.listen.length || a.etimeSec - b.etimeSec);
			return {
				type: "list",
				id: "quick",
				items: rows.slice(0, 8).map((r) => ({
					id: String(r.pid),
					title: name(r),
					subtitle: [r.listen.map((l) => `:${l.port}`).join(" "), tildify(r.cwd)].filter(Boolean).join("  "),
					dot: statusOf(r),
					meta: dur(r.etimeSec),
					actions: [{ id: "focus", label: "Show in terminal", icon: "square-terminal" }, ...(webUrl(r) ? [{ id: "open", label: "Open in browser", icon: "globe" }] : [])],
				})),
				empty: { title: "Nothing running", icon: "terminal" },
			};
		},
	},
	async onEvent(_surface, event, payload, c) {
		const pid = Number(payload?.rowId);
		const found = locate(pid);
		const row = found?.row;
		try {
			switch (event) {
				case "search":
					query = String(payload?.query ?? "").toLowerCase();
					c.invalidate();
					return;
				case "refresh":
					break;
				case "focus":
					if (row) await call("focus", { pid: row.pid });
					break;
				case "open": {
					const url = found && webUrl(found.member ?? found.row);
					if (url) await call("openUrl", { url });
					break;
				}
				case "stop":
					if (!row) break;
					await call("kill", found?.member ? { pid: row.pid, child: pid } : { pid });
					c.toast(`Stopped ${found?.member ? found.member.argvCommand : name(row)}`, "success");
					break;
				case "start":
					await call("start", { index: Number(payload?.rowId), terminal });
					c.toast("Started", "success");
					break;
				case "field":
					if (payload?.field === "sort") await call("setSort", { key: payload.value, desc: snap?.sort.desc ?? false });
					if (payload?.field === "terminal") terminal = String(payload.value);
					break;
			}
		} catch (e) {
			c.toast((e as Error).message, "error");
		}
		await refresh();
	},
});
