// Processes: a Toolbelt plugin that drives running-core (src/serve.ts in
// github.com/tkarakai/running) and draws its processes, kept commands and settings. It has
// everything running's TUI has: sections by terminal, folders and branches, agents, ports,
// output (and agents' conversations), keep / edit / forget / reorder, restart, stop and force
// stop, "why is it still alive", copy the command line, shell integration status.
// toolbelt-ps will replace the running-core bridge with the engine itself.
//
// running is vendored in ./running and bundled next to this plugin (paths.ts); tui.ts puts its
// terminal UI on the PATH.
import { definePlugin, type Context, type Dialog, type Field, type Node, type Row } from "../../src/sdk";
import { Core, type Hello, type KeepDraft, type Peek, type Snapshot, type SortKey } from "./core";
import { coreScript } from "./paths";
import { Tui } from "./tui";
import { agentState, build, displayName, dur, locate, sourceLabel, statusTone, stripAnsi, tildify, webUrl, type Built } from "./model";

const core = new Core(coreScript(), {
	onChanged: () => void refresh(),
	onExit: () => ctx.invalidate(),
});

const tui = new Tui({ onChange: () => ctx.invalidate() });

// ── state ────────────────────────────────────────────────────────────────
let snap: Snapshot | null = null;
let hello: Hello | null = null;
let query = "";
let showAll = false;
let terminal = "terminal";
let refreshing = false;
let last: Built | null = null;
/** Recent CPU / memory per pid, for the sparklines. */
const history = new Map<number, { cpu: number[]; mem: number[] }>();
const HISTORY = 30;

/** The dialog over the Processes or Kept page. */
type Open =
	| { kind: "output"; pid: number; child?: number; source?: string; data?: Peek; error?: string }
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

async function loadOutput() {
	if (dialog?.kind !== "output") return;
	const d = dialog;
	try {
		d.data = await core.call<Peek>("peek", { pid: d.pid, ...(d.child ? { child: d.child } : {}), ...(d.source ? { source: d.source } : {}), lines: 600 });
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
	description: `${core.error}. Rebuild the plugins (bun run plugins), or set RUNNING_CORE_SCRIPT to a running checkout's src/serve.ts.`,
});

const sortKey = (): SortKey => snap?.sort.key ?? "started";
const sortDesc = () => snap?.sort.desc ?? true;
const sortSpec = () => hello?.sorts[sortKey()];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dirLabel = () => sortSpec()?.dirLabel[sortDesc() ? 1 : 0] ?? (sortDesc() ? "descending" : "ascending");

/** The sources a peek can show, and which one is showing (running falls back to the first log
 *  file when a job has no terminal to read). */
function outputSources(d: Extract<Open, { kind: "output" }>) {
	const files = d.data?.sources ?? [];
	const fellBack = d.source === undefined && !!d.data && files.includes(d.data.title);
	const list: (string | undefined)[] = [...(fellBack ? [] : [undefined]), ...files].filter((s, i, a) => a.indexOf(s) === i);
	return { list, showing: fellBack ? d.data!.title : d.source };
}

function outputDialog(d: Extract<Open, { kind: "output" }>): Dialog {
	const { list, showing } = outputSources(d);
	const key = (s: string | undefined) => s ?? "@terminal";
	return {
		id: "output",
		title: d.data?.kind === "conversation" ? d.data.title : `Output — ${d.data?.title ?? "…"}`,
		description: d.error ?? `Last ${d.data?.lines.length ?? 0} lines · updates every 2 s`,
		wide: true,
		children: [
			...(list.length > 1
				? [{ type: "form" as const, id: "output", fields: [{ type: "select" as const, id: "source", label: "Show", value: key(showing), options: list.map((s) => ({ value: key(s), label: sourceLabel(s) })) }] }]
				: []),
			{ type: "log", id: `out:${d.pid}:${d.child ?? ""}:${showing ?? ""}`, lines: (d.data?.lines ?? []).map((t) => ({ text: stripAnsi(t) })), follow: true, empty: d.data ? "No output." : "Loading…" },
		],
		actions: [{ id: "output-copy", label: "Copy", icon: "copy" }],
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
	const spec = sortSpec();
	return {
		type: "page",
		search: { placeholder: "Filter by command, folder, port, pid, agent…" },
		summary: last ? `${last.shown} of ${last.total - last.hiddenApps} processes${last.hiddenApps ? ` · ${last.hiddenApps} apps hidden` : ""}` : "Loading…",
		highlight: last?.search.highlight(),
		actions: [
			{ id: "toggle-apps", label: showAll ? "Hide apps" : "Show apps", icon: showAll ? "eye-off" : "app-window" },
			{ id: "sort-next", label: `Sort: ${cap(spec?.label ?? sortKey())}`, icon: "arrow-down-up" },
			{ id: "sort-dir", label: cap(dirLabel()), icon: sortDesc() ? "arrow-down-wide-narrow" : "arrow-up-narrow-wide" },
			{ id: "refresh", label: "Refresh", icon: "refresh-cw" },
		],
		dialog: currentDialog("processes"),
		children: [
			{
				type: "table",
				id: "processes",
				columns: [
					{ key: "name", title: "Process", grow: true },
					{ key: "ports", title: "Ports" },
					{ key: "cpu", title: "CPU", align: "right", mono: true, optional: true },
					{ key: "mem", title: "Memory", align: "right", mono: true, optional: true },
					{ key: "uptime", title: "Up", align: "right", mono: true },
				],
				rows: last?.rows ?? [],
				actions: [
					{ id: "focus", label: "Show in terminal", icon: "square-terminal", inline: true },
					{ id: "open", label: "Open in browser", icon: "globe", inline: true },
					{ id: "output", label: "Show output", icon: "scroll-text", inline: true },
					{ id: "copy", label: "Copy cd && command", icon: "copy" },
					{ id: "keep", label: "Keep…", icon: "bookmark-plus" },
					{ id: "edit-kept", label: "Edit kept command…", icon: "bookmark" },
					{ id: "restart", label: "Restart", icon: "rotate-cw", confirm: "Stop it and run the same command again — in its terminal if that's still open, otherwise in a new window." },
					{ id: "why", label: "Why is it still running?", icon: "circle-help" },
					{ id: "stop", label: "Stop", icon: "square", tone: "destructive", confirm: "Stop it (SIGTERM, then SIGCONT so paused jobs can exit)?" },
					{ id: "kill", label: "Force stop", icon: "octagon-x", tone: "destructive", confirm: "Force stop it now (SIGKILL)? It gets no chance to clean up." },
				],
				empty: {
					title: !snap ? "Loading…" : query ? "No process matches" : "Nothing running",
					description: snap && !query ? (last?.hiddenApps ? "Apps and system servers are hidden — Show apps lists them." : "Processes you start in your terminals show up here.") : undefined,
					icon: "terminal",
				},
			},
		],
	};
}

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
							{ label: "Command", value: k.line, mono: true },
							{ label: "Directory", value: tildify(k.cwd), mono: true },
							...Object.entries(k.env).map(([key, v]) => ({ label: key, value: /KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH/i.test(key) ? "••••••" : v, mono: true })),
							...(k.note ? [{ label: "Note", value: k.note }] : []),
							...(k.ports.length ? [{ label: "Ports", value: k.ports.map((p) => `:${p}`).join(" ") }] : []),
							...(k.session ? [{ label: "Agent session", value: k.session, mono: true }] : []),
							...(k.kept ? [{ label: "Kept on", value: new Date(k.kept).toLocaleString() }] : []),
						],
					}),
				),
				actions: [
					{ id: "start", label: `Start in ${hello?.terminals[terminal]?.label ?? terminal}`, icon: "play", inline: true },
					{ id: "focus-kept", label: "Show in terminal", icon: "square-terminal", inline: true },
					{ id: "edit", label: "Edit…", icon: "pencil" },
					{ id: "copy", label: "Copy cd && command", icon: "copy" },
					{ id: "up", label: "Move up", icon: "arrow-up" },
					{ id: "down", label: "Move down", icon: "arrow-down" },
					{ id: "forget", label: "Forget", icon: "trash-2", tone: "destructive", confirm: "Forget this kept command? (You can undo right after.)" },
				],
				empty: { title: "Nothing kept yet", description: "Keep a process (its row menu → Keep…) to start it again later, with its folder and environment.", icon: "bookmark" },
			},
		],
	};
}

function settingsScreen(): Node {
	tui.checkOnce();
	return {
		type: "page",
		children: [
			{
				type: "form",
				id: "settings",
				title: "Kept commands",
				fields: [
					{ type: "select", id: "terminal", label: "Start them in", value: terminal, options: Object.entries(hello?.terminals ?? { terminal: { label: "Terminal" } }).map(([value, t]) => ({ value, label: t.label })) },
				],
			},
			tui.card(hello ? { logFile: hello.logFile, ...hello.shell } : null, hello?.version),
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
			actions: [{ id: "focus", label: "Show in terminal", icon: "square-terminal" }, ...(snap && webUrl(snap, r) ? [{ id: "open", label: "Open in browser", icon: "globe" }] : [])],
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
			if (event === "field" && payload?.form === "output" && dialog?.kind === "output") {
				dialog.source = payload.value === "@terminal" ? undefined : String(payload.value);
				dialog.data = undefined;
				c.invalidate();
				await loadOutput();
				return c.invalidate();
			}
			if (event === "output-copy" && dialog?.kind === "output") {
				c.copy((dialog.data?.lines ?? []).map(stripAnsi).join("\n"));
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
					showAll = !showAll;
					break;
				case "sort-next": {
					const keys = Object.keys(hello?.sorts ?? { started: 1, memory: 1, cpu: 1, name: 1 }) as SortKey[];
					const next = keys[(keys.indexOf(sortKey()) + 1) % keys.length];
					await core.call("setSort", { key: next, desc: hello?.sorts[next]?.desc ?? true });
					break;
				}
				case "sort-dir":
					await core.call("setSort", { key: sortKey(), desc: !sortDesc() });
					break;
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
				case "tui-install":
				case "tui-remove":
				case "tui-check":
					await tui.onEvent(event, c, async () => void (hello = (await core.call<Hello>("hello").catch(() => null)) ?? hello));
					return c.invalidate();
				case "copy-init":
					c.copy(`eval "$(command running init)"`);
					return c.toast("Copied — add it to ~/.zshrc, then open a new terminal", "success");
				case "field":
					if (payload?.field === "terminal") terminal = String(payload.value);
					break;
			}
		} catch (e) {
			c.toast((e as Error).message, "error");
		}
		await refresh();
	},
});
