// Processes: a Toolbelt plugin that drives running-core (src/serve.ts in
// github.com/tkarakai/running) and draws its processes, kept commands and settings. It has
// everything running's TUI has: sections by terminal, folders and branches, agents, ports,
// output (and agents' conversations), keep / edit / forget / reorder, restart, stop and force
// stop, "why is it still alive", copy the command line, shell integration status.
// toolbelt-ps will replace the running-core bridge with the engine itself.
//
// Where running is: RUNNING_CORE_SCRIPT, else ~/dev/projects/running/src/serve.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, definePlugin, type Action, type Context, type Dialog, type Field, type Message, type Node, type Row } from "../../src/sdk";
import { readConversation } from "./conversation";
import { Core, type Hello, type KeepDraft, type Peek, type Snapshot, type SortKey } from "./core";
import { agentState, build, COLUMN_SORT, displayName, dur, locate, SORT_COLUMN, sourceLabel, statusTone, stripAnsi, tildify, webUrl, type Built } from "./model";

const core = new Core(process.env.RUNNING_CORE_SCRIPT ?? `${homedir()}/dev/projects/running/src/serve.ts`, {
	onChanged: () => void refresh(),
	onExit: () => ctx.invalidate(),
});

// ── state ────────────────────────────────────────────────────────────────
let snap: Snapshot | null = null;
let hello: Hello | null = null;
let query = "";
// The person's choices, kept in the plugin's data folder across restarts.
const PREFS = join(dataDir(), "prefs.json");
const prefs: { showAll: boolean; terminal: string } = { showAll: false, terminal: "terminal" };
try {
	if (existsSync(PREFS)) Object.assign(prefs, JSON.parse(readFileSync(PREFS, "utf8")));
} catch {}
const savePrefs = () => {
	try {
		writeFileSync(PREFS, JSON.stringify(prefs, null, "\t") + "\n");
	} catch {}
};
let showAll = prefs.showAll;
let terminal = prefs.terminal;
let refreshing = false;
let last: Built | null = null;
/** Recent CPU / memory per pid, for the sparklines. */
const history = new Map<number, { cpu: number[]; mem: number[] }>();
const HISTORY = 30;

/** The dialog over the Processes or Kept page. */
type Open =
	| { kind: "output"; pid: number; child?: number; source?: string; data?: Peek; messages?: Message[]; error?: string }
	| { kind: "keep"; pid?: number; index?: number; draft: KeepDraft; saving?: boolean };
let dialog: Open | null = null;
let dialogScreen: "processes" | "kept" = "processes";

async function refresh() {
	if (refreshing || !core.running) return;
	refreshing = true;
	try {
		snap = await core.call<Snapshot>("snapshot");
		recordHistory(snap);
		ctx.badge(snap.rows.filter((r) => showAll || r.kind !== "app").length || null);
		if (dialog?.kind === "output") await loadOutput();
		ctx.invalidate();
	} catch (e) {
		if (!core.error) ctx.toast((e as Error).message, "error");
		ctx.invalidate();
	} finally {
		refreshing = false;
	}
}

function recordHistory(s: Snapshot) {
	const alive = new Set<number>();
	const push = (pid: number, cpu: number, rssKb: number) => {
		alive.add(pid);
		const h = history.get(pid) ?? { cpu: [], mem: [] };
		h.cpu.push(cpu);
		h.mem.push(rssKb);
		if (h.cpu.length > HISTORY) (h.cpu.shift(), h.mem.shift());
		history.set(pid, h);
	};
	for (const r of s.rows) {
		push(r.pid, r.cpu, r.rssKb);
		for (const m of r.members) push(m.pid, m.cpu, m.rssKb);
	}
	for (const pid of history.keys()) if (!alive.has(pid)) history.delete(pid);
}

/** How much of a terminal's scrollback (or a log file) a peek shows. */
const PEEK_LINES = 1000;

async function loadOutput() {
	if (dialog?.kind !== "output") return;
	const d = dialog;
	try {
		const conversation = d.source === "@transcript";
		d.data = await core.call<Peek>("peek", { pid: d.pid, ...(d.child ? { child: d.child } : {}), ...(d.source ? { source: d.source } : {}), lines: conversation ? 1 : PEEK_LINES });
		const agent = locate(snap, d.pid)?.row.agent;
		d.messages = conversation && agent?.transcript ? readConversation(agent.transcript, agent.harness) : undefined;
		d.error = undefined;
	} catch (e) {
		d.error = (e as Error).message;
	}
}

// ── views ────────────────────────────────────────────────────────────────
const unavailable = (): Node => ({
	type: "empty",
	icon: "plug-zap",
	title: "running-core isn't available",
	description: `${core.error}. Set RUNNING_CORE_SCRIPT to a checkout's src/serve.ts.`,
});

const sortKey = (): SortKey => snap?.sort.key ?? "started";
const sortDesc = () => snap?.sort.desc ?? true;
const sortSpec = () => hello?.sorts[sortKey()];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The sources a peek can show, and which one is showing (running falls back to the first log
 *  file when a job has no terminal to read). */
function outputSources(d: Extract<Open, { kind: "output" }>) {
	const files = d.data?.sources ?? [];
	const fellBack = d.source === undefined && !!d.data && files.includes(d.data.title);
	const list: (string | undefined)[] = [...(fellBack ? [] : [undefined]), ...files].filter((s, i, a) => a.indexOf(s) === i);
	return { list, showing: fellBack ? d.data!.title : d.source };
}

const sourceIcon = (s: string | undefined) => (s === undefined ? "square-terminal" : s === "@transcript" ? "messages-square" : "file-text");

function outputDialog(d: Extract<Open, { kind: "output" }>): Dialog {
	const { list, showing } = outputSources(d);
	const key = (s: string | undefined) => s ?? "@terminal";
	const row = locate(snap, d.pid);
	const name = row ? (row.member ? row.member.argvCommand : displayName(row.row)) : String(d.pid);
	const conversation = showing === "@transcript";
	const id = `out:${d.pid}:${d.child ?? ""}:${showing ?? ""}`;
	return {
		id: "output",
		title: `Peek — ${name}`,
		description: d.error ?? (conversation ? `${row?.row.agent?.harness ?? "Agent"} conversation · ${d.messages?.length ?? 0} messages · live` : `${d.data?.title ?? "…"} · ${d.data?.lines.length ?? 0} lines · live`),
		wide: true,
		resizable: true,
		children: [
			...(list.length > 1 ? [{ type: "segmented" as const, id: "output-source", value: key(showing), options: list.map((s) => ({ value: key(s), label: sourceLabel(s), icon: sourceIcon(s) })) }] : []),
			conversation
				? { type: "conversation" as const, id, messages: d.messages ?? [], empty: d.data ? "No messages yet." : "Loading…" }
				: { type: "terminal" as const, id, lines: d.data?.lines ?? [], follow: true, empty: d.data ? "No output." : "Loading…" },
		],
		actions: [{ id: "output-copy", label: "Copy all", icon: "copy" }],
	};
}

function keepDialog(d: Extract<Open, { kind: "keep" }>): Dialog {
	const editing = d.index !== undefined;
	const fields: Field[] = [
		{ type: "text", id: "name", label: "Name", value: d.draft.name, placeholder: "web dev server" },
		{ type: "text", id: "command", label: "Command", value: d.draft.command },
		{ type: "text", id: "cwd", label: "Directory", value: d.draft.cwd },
		{ type: "text", id: "note", label: "Note", value: d.draft.note, placeholder: "optional" },
		...d.draft.env.map(
			(e): Field => ({ type: "switch", id: `env:${e.key}`, label: e.key, value: e.selected, description: e.secret ? "•••••• (looks secret — off by default)" : e.value.length > 80 ? e.value.slice(0, 80) + "…" : e.value }),
		),
	];
	return {
		id: "keep",
		title: editing ? `Edit “${d.draft.name}”` : d.draft.title,
		description: d.draft.alreadyKept && !editing ? `Already kept as “${d.draft.alreadyKept.name}” — saving updates it.` : d.draft.env.length ? "Environment variables that differ from your shell can be kept with it." : undefined,
		children: [{ type: "form", id: "keep", fields }],
		actions: [{ id: "keep-save", label: editing || d.draft.alreadyKept ? "Save" : "Keep", icon: "bookmark", primary: true, disabled: d.saving || !d.draft.command.trim() }],
	};
}

const currentDialog = (screen: "processes" | "kept"): Dialog | undefined => {
	if (!dialog || dialogScreen !== screen) return undefined;
	return dialog.kind === "output" ? outputDialog(dialog) : keepDialog(dialog);
};

function processesScreen(): Node {
	if (core.error) return unavailable();
	last = snap ? build(snap, { query, showAll, sort: sortKey(), desc: sortDesc(), history }) : null;
	return {
		type: "page",
		search: { placeholder: "Filter by command, folder, port, pid, agent…" },
		summary: last ? `${last.shown} of ${last.total - last.hiddenApps} processes${last.hiddenApps ? ` · ${last.hiddenApps} apps hidden` : ""}` : "Loading…",
		highlight: last?.search.highlight(),
		actions: [
			{ id: "toggle-apps", label: "Show apps", checked: showAll },
			{ id: "refresh", label: "Refresh", icon: "refresh-cw" },
		],
		dialog: currentDialog("processes"),
		children: [
			{
				type: "table",
				id: "processes",
				// Narrow windows hide columns from the right; the process name always stays.
				columns: [
					{ key: "name", title: "Process", grow: true, minWidth: 260, sortable: true },
					{ key: "ports", title: "Ports" },
					{ key: "cpu", title: "CPU", align: "right", mono: true, sortable: true, sortDesc: true },
					{ key: "mem", title: "Memory", align: "right", mono: true, sortable: true, sortDesc: true },
					{ key: "uptime", title: "Up", align: "right", mono: true, sortable: true },
				],
				sort: { key: SORT_COLUMN[sortKey()], desc: sortDesc() },
				rows: last?.rows ?? [],
				actions: PROCESS_ACTIONS,
				empty: {
					title: !snap ? "Loading…" : query ? "No process matches" : "Nothing running",
					description: snap && !query ? (last?.hiddenApps ? "Apps and system servers are hidden — Show apps lists them." : "Processes you start in your terminals show up here.") : undefined,
					icon: "terminal",
				},
			},
		],
	};
}

/**
 * Row actions, in groups: get to it (its terminal, its output, its page) · understand it · keep
 * or reuse its command · restart it · stop it.
 */
const PROCESS_ACTIONS: Action[] = [
	{ id: "focus", label: "Jump to terminal", icon: "square-arrow-out-up-right", inline: true, group: "go" },
	{ id: "output", label: "Peek", icon: "scan-eye", inline: true, group: "go" },
	{ id: "open", label: "Open in browser", icon: "globe", inline: true, group: "go" },
	{ id: "why", label: "Why is it still running?", icon: "circle-help", group: "go" },
	{ id: "keep", label: "Keep…", icon: "bookmark-plus", group: "command" },
	{ id: "edit-kept", label: "Edit kept command…", icon: "bookmark", group: "command" },
	{ id: "copy", label: "Copy cd && command", icon: "copy", group: "command" },
	{ id: "restart", label: "Restart", icon: "rotate-cw", group: "run", confirm: "Stop it and run the same command again — in its terminal if that's still open, otherwise in a new window." },
	{ id: "stop", label: "Stop", icon: "square", tone: "destructive", group: "stop", confirm: "Stop it (SIGTERM, then SIGCONT so paused jobs can exit)?" },
	{ id: "kill", label: "Force stop", icon: "octagon-x", tone: "destructive", group: "stop", confirm: "Force stop it now (SIGKILL)? It gets no chance to clean up." },
];

function keptScreen(): Node {
	if (core.error) return unavailable();
	const kept = snap?.kept ?? [];
	return {
		type: "page",
		summary: `${kept.length} kept · ${kept.filter((k) => k.livePid).length} running`,
		dialog: currentDialog("kept"),
		children: [
			{
				type: "table",
				id: "kept",
				columns: [
					{ key: "name", title: "Name", grow: true },
					{ key: "dir", title: "Directory", optional: true },
					{ key: "state", title: "State" },
				],
				rows: kept.map(
					(k, i): Row => ({
						id: String(k.index),
						cells: {
							name: { text: k.name || k.command, sub: k.line, mono: false },
							dir: { text: tildify(k.cwd), mono: true, tone: "muted" },
							state: k.livePid ? { text: "Running", dot: "success", sub: `pid ${k.livePid}` } : { text: "Stopped", dot: "muted", tone: "muted" },
						},
						actions: [...(k.livePid ? ["focus-kept"] : ["start"]), "edit", "copy", ...(i > 0 ? ["up"] : []), ...(i < kept.length - 1 ? ["down"] : []), "forget"],
						details: [
							{ section: "Command", label: "Command", value: k.line, mono: true },
							{ section: "Command", label: "Directory", value: tildify(k.cwd), mono: true },
							...(k.note ? [{ section: "Command", label: "Note", value: k.note }] : []),
							...Object.entries(k.env).map(([key, v]) => {
								const secret = /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH/i.test(key);
								return { section: "Environment", label: key, value: secret ? "••••••" : v, mono: true, copy: !secret };
							}),
							...(k.livePid ? [{ section: "State", label: "Running", value: `pid ${k.livePid}`, mono: true, copy: false, tone: "success" as const }] : [{ section: "State", label: "State", value: "Stopped" }]),
							...(k.ports.length ? [{ section: "State", label: "Ports", value: k.ports.map((p) => `:${p}`).join(" ") }] : []),
							...(k.session ? [{ section: "State", label: "Agent session", value: k.session, mono: true }] : []),
							...(k.kept ? [{ section: "State", label: "Kept on", value: new Date(k.kept).toLocaleString() }] : []),
						],
					}),
				),
				actions: [
					{ id: "start", label: `Start in ${hello?.terminals[terminal]?.label ?? terminal}`, icon: "play", inline: true, group: "run" },
					{ id: "focus-kept", label: "Jump to terminal", icon: "square-arrow-out-up-right", inline: true, group: "run" },
					{ id: "edit", label: "Edit…", icon: "pencil", group: "command" },
					{ id: "copy", label: "Copy cd && command", icon: "copy", group: "command" },
					{ id: "up", label: "Move up", icon: "arrow-up", group: "order" },
					{ id: "down", label: "Move down", icon: "arrow-down", group: "order" },
					{ id: "forget", label: "Forget", icon: "trash-2", tone: "destructive", group: "forget", confirm: "Forget this kept command? (You can undo right after.)" },
				],
				empty: { title: "Nothing kept yet", description: "Keep a process (its row menu → Keep…) to start it again later, with its folder and environment.", icon: "bookmark" },
			},
		],
	};
}

function settingsScreen(): Node {
	const sh = hello?.shell;
	return {
		type: "page",
		children: [
			{
				type: "form",
				id: "settings",
				title: "The list",
				fields: [
					{ type: "select", id: "sort", label: "Sort by", value: sortKey(), options: Object.entries(hello?.sorts ?? {}).map(([value, s]) => ({ value, label: cap(s.label) })), description: "Shared with running's terminal UI." },
					{ type: "select", id: "dir", label: "Order", value: sortDesc() ? "desc" : "asc", options: [{ value: "asc", label: cap(sortSpec()?.dirLabel[0] ?? "ascending") }, { value: "desc", label: cap(sortSpec()?.dirLabel[1] ?? "descending") }] },
					{ type: "switch", id: "showAll", label: "Show apps and system servers", value: showAll, description: "Desktop apps and servers you didn't start in a terminal." },
					{ type: "select", id: "terminal", label: "Start kept commands in", value: terminal, options: Object.entries(hello?.terminals ?? { terminal: { label: "Terminal" } }).map(([value, t]) => ({ value, label: t.label })) },
				],
			},
			{
				type: "card",
				id: "shell",
				title: "Shell integration",
				description: "running's zsh hook remembers the commands you type, so Processes can show what you typed (not just what's running), restart it, and name jobs whose launcher exited.",
				tone: sh && sh.zshrc && sh.logExists ? "success" : "warning",
				actions: [{ id: "copy-init", label: "Copy setup line", icon: "copy", primary: !sh?.zshrc }],
				children: [
					{
						type: "details",
						items: [
							{ label: "In ~/.zshrc", value: sh?.zshrc ? "yes" : "no — add the setup line below", tone: sh?.zshrc ? "success" : "warning" },
							{ label: "Command log", value: sh?.logExists ? `written ${sh.logAgeSec !== undefined ? dur(sh.logAgeSec) + " ago" : ""}` : "none yet", tone: sh?.logExists ? "default" : "warning", mono: false },
							{ label: "Setup line", value: `echo 'eval "$(command running init)"' >> ~/.zshrc`, mono: true },
						],
					},
				],
			},
			{
				type: "card",
				id: "core",
				title: "running-core",
				children: [
					{
						type: "details",
						items: [
							{ label: "Version", value: hello?.version ?? "?" },
							{ label: "Engine", value: tildify(core.script), mono: true },
							{ label: "Kept commands", value: hello ? tildify(hello.keptFile) : "?", mono: true },
							{ label: "Command log", value: hello ? tildify(hello.logFile) : "?", mono: true },
						],
					},
				],
			},
		],
	};
}

function quickView(): Node {
	if (core.error) return unavailable();
	const rows = (snap?.rows ?? []).filter((r) => r.kind !== "app").sort((a, b) => b.listen.length - a.listen.length || a.etimeSec - b.etimeSec);
	return {
		type: "list",
		id: "quick",
		items: rows.slice(0, 8).map((r) => ({
			id: String(r.pid),
			title: displayName(r),
			subtitle: [r.agent ? `${r.agent.harness} · ${agentState(r.agent)}` : r.listen.map((l) => `:${l.port}`).join(" "), tildify(r.cwd)].filter(Boolean).join("  "),
			dot: statusTone(r),
			meta: dur(r.etimeSec),
			actions: [{ id: "focus", label: "Jump to terminal", icon: "square-arrow-out-up-right" }, ...(snap && webUrl(snap, r) ? [{ id: "open", label: "Open in browser", icon: "globe" }] : [])],
		})),
		empty: { title: "Nothing running", icon: "terminal" },
	};
}

// ── plugin ───────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
function schedule(c: Context) {
	if (timer) clearInterval(timer);
	// Every 2 s while something is on screen (sparklines, live output), every 15 s for the badge.
	timer = setInterval(() => void refresh(), c.open.size ? 2000 : 15000);
}

/** After a stop: if it's still there a moment later, say why (zombie, stuck on disk, respawned). */
function checkSurvivor(pid: number, child: number | undefined, name: string, c: Context) {
	setTimeout(async () => {
		await refresh();
		if (!locate(snap, child ?? pid)) return;
		try {
			const res = await core.call<{ alive: boolean; reason?: string }>("whyAlive", { pid, ...(child ? { child } : {}) });
			if (res.alive) c.toast(`${name} is still running${res.reason ? `: ${res.reason}` : ""}`, "error");
		} catch {}
	}, 2500);
}

const ctx = definePlugin({
	async start(c) {
		core.start();
		if (core.running) hello = await core.call<Hello>("hello").catch(() => null);
		await refresh();
		schedule(c);
	},
	onOpen: (_s, c) => {
		schedule(c);
		void refresh();
	},
	onClose: (s, c) => {
		if ((s === "screen:processes" || s === "screen:kept") && dialog) dialog = null;
		schedule(c);
	},
	render: {
		"screen:processes": processesScreen,
		"screen:kept": keptScreen,
		"screen:settings": settingsScreen,
		quick: quickView,
	},
	async onEvent(surface, event, payload, c) {
		const screen = surface === "screen:kept" ? "kept" : "processes";
		const pid = Number(payload?.rowId);
		const found = locate(snap, pid);
		const row = found?.row;
		const child = found?.member?.pid;
		const label = found?.member ? found.member.argvCommand : row ? displayName(row) : String(pid);
		const keptAt = (id: unknown) => snap?.kept.find((k) => k.index === Number(id));
		try {
			// ── dialogs ──
			if (event === "dialog-close") {
				dialog = null;
				return c.invalidate();
			}
			if (event === "field" && payload?.form === "output-source" && dialog?.kind === "output") {
				dialog.source = payload.value === "@terminal" ? undefined : String(payload.value);
				dialog.data = undefined;
				c.invalidate();
				await loadOutput();
				return c.invalidate();
			}
			if (event === "output-copy" && dialog?.kind === "output") {
				const d = dialog;
				c.copy(d.source === "@transcript" ? (d.messages ?? []).map((m) => (m.role === "tool" ? `[${m.tool?.name}] ${m.text}` : `${m.author}:\n${m.text}`)).join("\n\n") : (d.data?.lines ?? []).map(stripAnsi).join("\n"));
				return c.toast("Output copied", "success");
			}
			if (event === "field" && payload?.form === "keep" && dialog?.kind === "keep") {
				const f = String(payload.field);
				if (f.startsWith("env:")) {
					const e = dialog.draft.env.find((x) => x.key === f.slice(4));
					if (e) e.selected = !!payload.value;
				} else if (f === "name" || f === "command" || f === "cwd" || f === "note") dialog.draft[f] = String(payload.value);
				return c.invalidate();
			}
			if (event === "keep-save" && dialog?.kind === "keep") {
				const d = dialog;
				const values = { name: d.draft.name, command: d.draft.command, cwd: d.draft.cwd, note: d.draft.note, env: d.draft.env };
				const index = d.index ?? d.draft.alreadyKept?.index;
				d.saving = true;
				c.invalidate();
				const res = index !== undefined ? await core.call<{ ok: boolean; message: string }>("edit", { index, values }) : await core.call<{ ok: boolean; message: string }>("keep", { pid: d.pid, values });
				d.saving = false;
				c.toast(res.message, res.ok ? "success" : "error");
				if (res.ok) dialog = null;
				return void (await refresh());
			}
			if (surface === "toast" && event === "undo-forget") {
				const res = await core.call<{ ok: boolean; message: string }>("restoreKept", { kept: payload?.kept, index: payload?.index });
				c.toast(res.message, res.ok ? "success" : "error");
				return void (await refresh());
			}

			switch (event) {
				case "search":
					query = String(payload?.query ?? "");
					return c.invalidate();
				case "refresh":
					break;
				case "toggle-apps":
					showAll = prefs.showAll = !showAll;
					savePrefs();
					break;
				case "sort": {
					const key = COLUMN_SORT[String(payload?.key)];
					if (key) await core.call("setSort", { key, desc: !!payload?.desc });
					break;
				}
				case "focus":
					if (row) await core.call("focus", { pid: row.pid });
					break;
				case "open": {
					const url = found && snap && webUrl(snap, found.member ?? found.row);
					if (url) await core.call("openUrl", { url });
					break;
				}
				case "output":
					if (!row) break;
					dialog = { kind: "output", pid: row.pid, child, source: !child && row.agent?.transcript ? "@transcript" : undefined };
					dialogScreen = "processes";
					c.invalidate();
					await loadOutput();
					return c.invalidate();
				case "copy": {
					const k = screen === "kept" ? keptAt(payload?.rowId) : undefined;
					const cwd = k ? k.cwd : (found?.member?.cwd ?? row?.cwd ?? "");
					const command = k ? k.line : (found?.member?.argvCommand ?? row?.command ?? "");
					const res = await core.call<{ line: string }>("copyLine", { cwd, command });
					c.copy(res.line);
					return c.toast("Copied — paste it in a terminal", "success");
				}
				case "keep": {
					if (!row) break;
					const draft = await core.call<KeepDraft>("keepDraft", { pid: row.pid });
					dialog = { kind: "keep", pid: row.pid, draft };
					dialogScreen = "processes";
					return c.invalidate();
				}
				case "edit-kept":
				case "edit": {
					const k = event === "edit" ? keptAt(payload?.rowId) : row?.keptIndex !== undefined ? keptAt(row.keptIndex) : undefined;
					if (!k) break;
					dialog = {
						kind: "keep",
						index: k.index,
						draft: { title: "Edit kept command", name: k.name ?? "", command: k.command, cwd: k.cwd, note: k.note, env: Object.entries(k.env).map(([key, value]) => ({ key, value, secret: false, selected: true })) },
					};
					dialogScreen = event === "edit" ? "kept" : "processes";
					return c.invalidate();
				}
				case "restart": {
					if (!row) break;
					const res = await core.call<{ ok: boolean; message?: string }>("restart", { pid: row.pid, terminal });
					c.toast(res.message ?? (res.ok ? "Restarted" : "Couldn't restart"), res.ok ? "success" : "error");
					break;
				}
				case "stop":
				case "kill":
					if (!row) break;
					await core.call("kill", { pid: row.pid, ...(child ? { child } : {}), ...(event === "kill" ? { force: true } : {}) });
					c.toast(`${event === "kill" ? "Force-stopped" : "Stopped"} ${label}`, "success");
					checkSurvivor(row.pid, child, label, c);
					break;
				case "why": {
					if (!row) break;
					const res = await core.call<{ alive: boolean; reason?: string }>("whyAlive", { pid: row.pid, ...(child ? { child } : {}) });
					c.toast(res.alive ? `${label}: ${res.reason ?? "still running"}` : `${label} has exited`, res.alive ? "default" : "success");
					break;
				}
				case "start": {
					const res = await core.call<{ ok?: boolean; message?: string }>("start", { index: Number(payload?.rowId), terminal });
					c.toast(res?.message ?? "Started", res?.ok === false ? "error" : "success");
					break;
				}
				case "focus-kept": {
					const live = keptAt(payload?.rowId)?.livePid;
					if (live) await core.call("focus", { pid: live });
					break;
				}
				case "up":
				case "down": {
					const from = Number(payload?.rowId);
					await core.call("move", { from, to: from + (event === "up" ? -1 : 1) });
					break;
				}
				case "forget": {
					const index = Number(payload?.rowId);
					const res = await core.call<{ ok: boolean; message: string; restore: unknown }>("forget", { index });
					c.toast(res.message, "success", { id: "undo-forget", label: "Undo", payload: { kept: res.restore, index } });
					break;
				}
				case "copy-init":
					c.copy(`eval "$(command running init)"`);
					return c.toast("Copied — add it to ~/.zshrc, then open a new terminal", "success");
				case "field":
					if (payload?.field === "sort") await core.call("setSort", { key: payload.value, desc: hello?.sorts[payload.value as SortKey]?.desc ?? sortDesc() });
					if (payload?.field === "dir") await core.call("setSort", { key: sortKey(), desc: payload.value === "desc" });
					if (payload?.field === "showAll") showAll = prefs.showAll = !!payload.value;
					if (payload?.field === "terminal") terminal = prefs.terminal = String(payload.value);
					savePrefs();
					break;
			}
		} catch (e) {
			c.toast((e as Error).message, "error");
		}
		await refresh();
	},
});
