// The agent interface's core (docs/agent-interface.md): sessions, per-plugin access, the agent's own view
// of plugin surfaces, the registry of agent operations, and the audit log. Transports (the MCP
// socket, the CLI) are adapters over `call`. Agents can only read in this version.
import type { Manifest, Node, Row } from "../../shared/protocol";
import type { PluginInfo } from "../../shared/plugin-state";
import {
	atLeast,
	ceilingOf,
	declaredAccess,
	defaultAccess,
	effectiveAccess,
	type AgentAccess,
	type AgentMode,
	type AgentPlugin,
	type AgentSession,
	type AgentSettings,
	type AgentsRequest,
	type AgentsState,
	type AuditEntry,
	type AuditPage,
} from "../../shared/agents";
import { AuditLog } from "./audit";
import { findRow, searchText, treeJson, treeText, TEXT_BUDGET, when, type SearchHit } from "./serialize";

/** The parts of PluginHost the agent interface uses. */
export type AgentHost = {
	list(): PluginInfo[];
	open(plugin: string, surface: string): unknown;
	close(plugin: string, surface: string): void;
	/** The surface's cached tree; `error` when its last render was rejected (the tree is then null). */
	snapshot(plugin: string, surface: string): { tree: Node | null; at: number; viewers: number; error?: string } | null;
	subscribe(listener: {
		plugins(list: PluginInfo[]): void;
		tree(plugin: string, surface: string, tree: Node): void;
		toast(): void;
	}): () => void;
};

export type InstalledSummary = {
	id: string;
	name: string;
	version: string;
	repo?: string;
	enabled: boolean;
	phase?: string;
	availableVersion?: string;
	channel?: string;
	/** The manifest's `agent.access`, or null when it declares none. */
	declared: AgentAccess | null;
};

export type AgentCoreOptions = {
	host: AgentHost;
	settings(): AgentSettings;
	save(next: AgentSettings): void;
	/** `location`: the app bundle (or source folder) answering, so agents can tell builds apart. */
	app(): { name: string; version: string; channel: string; developmentProfile: string | null; location?: string | null };
	appUpdate?(): { available: string | null; lastChecked: number | null };
	installed?(): InstalledSummary[];
	auditFile: string;
	socket: string;
	command: string[] | null;
	/** Why `command` may not keep working (a development build), shown in Settings → Agents. */
	commandWarning?: string | null;
	/** Settings → Agents changed. */
	changed(state: AgentsState): void;
	/** How long the agent keeps a surface open after its last read (ms). Default 60 s. */
	holdMs?: number;
	/** How long a read waits for a surface's first render (ms). Default 4 s. */
	renderWaitMs?: number;
	/** The clock for relative times in plugin content ("in 2h"). Tests fix it; default `Date.now`. */
	now?: () => number;
};

/** JSON Schema, as MCP tools declare their input. */
type Schema = Record<string, unknown>;
/**
 * An operation's result. `data` is the same information as structured data: it is returned (as MCP
 * `structuredContent`, and as the text) only when the caller asks for `format: "json"`. `kind`
 * says why a call failed: refused (unknown or hidden), unavailable (the plugin can't be read
 * now) or another error.
 */
export type CallResult = { text: string; data?: unknown; isError?: boolean; kind?: "refused" | "unavailable" | "error" };
export type Operation = {
	name: string;
	title: string;
	description: string;
	/** Every operation in this version is `read`. */
	risk: "read";
	params: Schema;
	run(session: AgentSession, params: Record<string, unknown>): Promise<CallResult>;
};

/** The agent asked for something it can't have or that doesn't exist: audited as `denied`. */
export class AgentRefusal extends Error {}
/** What the agent asked for exists but can't be read now (a crashed plugin, a failed render): audited as `error`. */
export class AgentUnavailable extends Error {}

/** Close matches for a mistyped id: same letters in another case, a prefix, or one or two edits away. */
export function suggest(wanted: string, candidates: { id: string; title?: string }[]) {
	const w = wanted.toLowerCase();
	const distance = (a: string, b: string) => {
		const d = Array.from({ length: b.length + 1 }, (_, i) => i);
		for (let i = 1; i <= a.length; i++) {
			let prev = d[0];
			d[0] = i;
			for (let j = 1; j <= b.length; j++) {
				const t = d[j];
				d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
				prev = t;
			}
		}
		return d[b.length];
	};
	return candidates
		.filter((c) => {
			const names = [c.id.toLowerCase(), ...(c.title ? [c.title.toLowerCase()] : [])];
			return w.length > 0 && names.some((n) => n.startsWith(w) || w.startsWith(n) || distance(n, w) <= Math.min(2, Math.floor(n.length / 3)));
		})
		.map((c) => c.id);
}
const UNAVAILABLE = (id: string, close: string[] = []) =>
	new AgentRefusal(`No plugin "${id}" is available to agents.${close.length ? ` Did you mean ${close.map((c) => `"${c}"`).join(" or ")}?` : ""} Call list_screens to see what is.`);
/** An epoch-milliseconds time as ISO 8601, or null. */
const iso = (at: number | null | undefined) => (at ? new Date(at).toISOString() : null);
/** A plugin's badge, only while it runs: a stopped plugin's last badge is stale. */
const badgeOf = (info: PluginInfo) => (info.state === "running" && info.badge !== undefined ? info.badge : null);
/** A table node by id, anywhere in a tree. */
function tableOf(tree: unknown, id: string): { rows: Row[] } | undefined {
	if (Array.isArray(tree)) {
		for (const v of tree) {
			const t = tableOf(v, id);
			if (t) return t;
		}
	} else if (tree && typeof tree === "object") {
		const o = tree as Record<string, unknown>;
		if (o.type === "table" && o.id === id && Array.isArray(o.rows)) return o as { rows: Row[] };
		for (const v of Object.values(o)) {
			const t = v && typeof v === "object" ? tableOf(v, id) : undefined;
			if (t) return t;
		}
	}
	return undefined;
}
/** Ids of every table in a tree (also in dialogs and row panes). */
function tableIds(tree: unknown, ids: string[] = []): string[] {
	if (Array.isArray(tree)) for (const v of tree) tableIds(v, ids);
	else if (tree && typeof tree === "object") {
		const o = tree as Record<string, unknown>;
		if (o.type === "table" && typeof o.id === "string" && !ids.includes(o.id)) ids.push(o.id);
		for (const v of Object.values(o)) if (v && typeof v === "object") tableIds(v, ids);
	}
	return ids;
}

/** How long after a grouped connection ends a new one in its group continues its session. */
const GROUP_MS = 10 * 60_000;

export type ScreenRef = { plugin: string; screen: string; title: string; pluginName: string; default: boolean; /** The plugin's state: only running plugins can be read. */ state: string };

export class AgentCore {
	private sessions = new Map<string, AgentSession>();
	private audit: AuditLog;
	/** Surfaces the agent holds open: key → release timer (null while a subscription pins it). */
	private holds = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pins: number }>();
	private waiters = new Set<{ plugin: string; surface: string; done: () => void }>();
	private treeListeners = new Set<(plugin: string, surface: string) => void>();
	private pluginListeners = new Set<() => void>();
	private running = false;
	private error: string | null = null;
	readonly operations: Operation[];
	get version() {
		return this.o.app().version;
	}
	private now() {
		return this.o.now?.() ?? Date.now();
	}

	constructor(private readonly o: AgentCoreOptions) {
		this.audit = new AuditLog(o.auditFile);
		o.host.subscribe({
			plugins: () => {
				this.pluginListeners.forEach((l) => l());
				this.emit();
			},
			tree: (plugin, surface) => {
				for (const w of [...this.waiters]) if (w.plugin === plugin && w.surface === surface) w.done();
				this.treeListeners.forEach((l) => l(plugin, surface));
			},
			toast: () => {},
		});
		this.operations = this.defineOperations();
	}

	// ── access ───────────────────────────────────────────────────────────
	private pluginsWithAccess(): (AgentPlugin & { info: PluginInfo })[] {
		const choices = this.o.settings().access;
		const updates = new Map((this.o.installed?.() ?? []).map((p) => [p.id, p.availableVersion]));
		return this.o.host.list().map((info) => {
			const declared = declaredAccess(info.manifest);
			const choice = choices[info.manifest.id];
			const update = updates.get(info.manifest.id);
			return {
				id: info.manifest.id,
				name: info.manifest.name,
				icon: info.manifest.icon,
				ceiling: ceilingOf(declared),
				byDefault: defaultAccess(declared),
				choice,
				effective: effectiveAccess(declared, choice),
				declared: declared !== null,
				...(update ? { update } : {}),
				info,
			};
		});
	}

	/** Plugins agents may see at `needed` or above. */
	visible(needed: AgentAccess = "read") {
		return this.pluginsWithAccess().filter((p) => atLeast(p.effective, needed));
	}

	/** A visible plugin by id (any case) or name; refuses with close matches among visible plugins. */
	private plugin(id: unknown) {
		const visible = this.visible();
		const wanted = typeof id === "string" ? id.trim().toLowerCase() : "";
		const p = visible.find((x) => x.id === id) ?? visible.find((x) => x.id.toLowerCase() === wanted || x.name.toLowerCase() === wanted);
		if (!p) throw UNAVAILABLE(String(id), suggest(wanted, visible.map((x) => ({ id: x.id, title: x.name }))));
		return p;
	}

	screens(): ScreenRef[] {
		return this.visible().flatMap((p) =>
			p.info.manifest.screens.map((s, i) => ({
				plugin: p.id,
				screen: s.id,
				title: s.title,
				pluginName: p.name,
				default: s.default ?? (i === 0 && !p.info.manifest.screens.some((x) => x.default)),
				state: p.info.state,
			})),
		);
	}

	// ── the agent's view: open surfaces on demand, release them when idle ─
	private key = (plugin: string, surface: string) => `${plugin}\n${surface}`;

	private hold(plugin: string, surface: string, pin = false) {
		const key = this.key(plugin, surface);
		let h = this.holds.get(key);
		if (!h) {
			h = { timer: null, pins: 0 };
			this.holds.set(key, h);
			this.o.host.open(plugin, surface);
		}
		if (h.timer) clearTimeout(h.timer);
		h.timer = null;
		if (pin) h.pins++;
		if (!h.pins) h.timer = setTimeout(() => this.release(key), this.o.holdMs ?? 60_000);
	}

	private release(key: string) {
		const h = this.holds.get(key);
		if (!h || h.pins) return;
		if (h.timer) clearTimeout(h.timer);
		this.holds.delete(key);
		const [plugin, surface] = key.split("\n");
		this.o.host.close(plugin, surface);
	}

	/** Keeps a surface open while something watches it (an MCP resource subscription). */
	pin(plugin: string, surface: string) {
		this.hold(plugin, surface, true);
		return () => {
			const h = this.holds.get(this.key(plugin, surface));
			if (!h) return;
			h.pins = Math.max(0, h.pins - 1);
			if (!h.pins) h.timer = setTimeout(() => this.release(this.key(plugin, surface)), this.o.holdMs ?? 60_000);
		};
	}

	onTree(listener: (plugin: string, surface: string) => void) {
		this.treeListeners.add(listener);
		return () => void this.treeListeners.delete(listener);
	}
	onPlugins(listener: () => void) {
		this.pluginListeners.add(listener);
		return () => void this.pluginListeners.delete(listener);
	}

	/** The surface's current tree, opening it first and waiting briefly if nobody was watching it. */
	async fresh(plugin: string, surface: string) {
		const before = this.o.host.snapshot(plugin, surface);
		const watched = (before?.viewers ?? 0) > 0 && !!before?.tree;
		const pending = watched
			? null
			: new Promise<void>((resolve) => {
					const w = { plugin, surface, done: () => (this.waiters.delete(w), resolve()) };
					this.waiters.add(w);
					setTimeout(w.done, this.o.renderWaitMs ?? 4000);
				});
		this.hold(plugin, surface);
		await pending;
		return this.o.host.snapshot(plugin, surface);
	}

	/** One screen, read for an agent. Throws AgentRefusal when it isn't available, AgentUnavailable when it can't be read now. */
	async readScreen(pluginId: unknown, screenId: unknown, options: { format?: "text" | "json"; maxRows?: number; table?: string; offset?: number; details?: boolean; budget?: number; parent?: string; resource?: string } = {}) {
		const p = this.plugin(pluginId);
		const manifest = p.info.manifest as Manifest;
		const wanted = typeof screenId === "string" ? screenId.trim().toLowerCase() : "";
		const screen = screenId === undefined || screenId === null || screenId === ""
			? (manifest.screens.find((s) => s.default) ?? manifest.screens[0])
			: (manifest.screens.find((s) => s.id === screenId) ?? manifest.screens.find((s) => s.id.toLowerCase() === wanted || s.title.toLowerCase() === wanted));
		if (!screen) {
			const close = suggest(wanted, manifest.screens);
			throw new AgentRefusal(`${p.name} has no screen "${String(screenId)}".${close.length ? ` Did you mean ${close.map((c) => `"${c}"`).join(" or ")}?` : ""} Its screens: ${manifest.screens.map((s) => `${s.id} (${s.title})`).join(", ")}.`);
		}
		if (p.info.state !== "running")
			throw new AgentUnavailable(`${p.name} is ${p.info.state}${p.info.error ? `: ${p.info.error.split("\n")[0]}` : ""}. The person can restart it in ToolBelt.`);
		const snap = await this.fresh(p.id, `screen:${screen.id}`);
		const ref = { plugin: p.id, screen: screen.id, pluginName: p.name, title: screen.title };
		if (snap?.error) throw new AgentUnavailable(`${p.name} › ${screen.title} couldn't be shown: ${snap.error}`);
		if (!snap?.tree) return { ref, tree: null, rendered: false, text: `${p.name} › ${screen.title} hasn't rendered yet. Try again in a moment.`, viewState: [] as string[], at: 0, watched: false };
		// Paging names a table: refuse one that isn't there; `offset` alone pages the only table.
		const tables = tableIds(snap.tree);
		let table = options.table;
		if (table !== undefined && !tables.includes(table))
			throw new AgentRefusal(`${p.name} › ${screen.title} has no table "${table}". ${tables.length ? `Its tables: ${tables.join(", ")}.` : "It has no tables."}`);
		if (table === undefined && (options.offset !== undefined || options.parent !== undefined)) {
			if (tables.length !== 1) throw new AgentRefusal(`${options.parent !== undefined ? "parent" : "offset"} pages one table: pass table too. ${tables.length ? `Tables on this screen: ${tables.join(", ")}.` : "This screen has no tables."}`);
			table = tables[0];
		}
		if (options.parent !== undefined && !findRow(tableOf(snap.tree, table!)?.rows ?? [], options.parent))
			throw new AgentRefusal(`Table "${table}" has no row "${options.parent}". Row ids are shown as {id: …}.`);
		const read = { ...options, table, now: this.now() };
		const shared = snap.viewers > 1; // someone besides the agent has it open
		// JSON carries the same view-state notes as text (a search or filter the person set).
		if (options.format === "json") return { ref, tree: treeJson(snap.tree, read), rendered: true, text: "", viewState: treeText(snap.tree, { maxRows: 0, details: false }).viewState, at: snap.at, watched: shared };
		const { text, viewState } = treeText(snap.tree, read);
		return { ref, tree: null, rendered: true, text, viewState, at: snap.at, watched: shared };
	}

	// ── sessions and audit ────────────────────────────────────────────────
	/**
	 * A connection's session. Connections that name the same `group` (the CLI sends its parent
	 * process, so one script or shell's calls group) within GROUP_MS of the last one ending
	 * continue its session id, so the audit log shows them as one session. Concurrent connections
	 * get their own ids.
	 */
	openSession(client: string, mode: AgentMode, group?: string): AgentSession {
		const name = client.slice(0, 64) || "agent";
		const key = group ? `${name}\n${mode}\n${group.slice(0, 64)}` : null;
		const recent = key ? this.recentGroups.get(key) : undefined;
		const id = recent && Date.now() - recent.closed < GROUP_MS && !this.sessions.has(recent.id) ? recent.id : crypto.randomUUID();
		const session = { id, client: name, mode, since: Date.now() };
		this.sessions.set(session.id, session);
		if (key) this.groupOf.set(session, key);
		this.emit();
		return session;
	}
	private recentGroups = new Map<string, { id: string; closed: number }>();
	private groupOf = new WeakMap<AgentSession, string>();
	renameSession(session: AgentSession, client: string) {
		session.client = client.slice(0, 64) || session.client;
		this.emit();
	}
	closeSession(session: AgentSession) {
		const key = this.groupOf.get(session);
		if (key) {
			this.recentGroups.set(key, { id: session.id, closed: Date.now() });
			for (const [k, v] of this.recentGroups) if (Date.now() - v.closed > GROUP_MS) this.recentGroups.delete(k);
		}
		if (this.sessions.get(session.id) === session && this.sessions.delete(session.id)) this.emit();
	}

	private record(session: AgentSession, entry: Omit<AuditEntry, "at" | "session" | "client" | "mode">) {
		this.audit.append({ at: Date.now(), session: session.id, client: session.client, mode: session.mode, ...entry });
	}

	/** Runs an operation for a session: the one entry point every transport uses. */
	async call(session: AgentSession, name: string, params: Record<string, unknown> = {}): Promise<CallResult> {
		const op = this.operations.find((o) => o.name === name);
		const plugin = typeof params.plugin === "string" ? params.plugin : undefined;
		const screen = typeof params.screen === "string" ? params.screen : undefined;
		if (!op) {
			this.record(session, { operation: name.slice(0, 64), outcome: "denied", detail: "unknown operation" });
			return { text: `Unknown tool ${name}.`, isError: true };
		}
		try {
			const result = await op.run(session, params);
			this.record(session, { operation: name, plugin, screen, outcome: result.isError ? "error" : "ok" });
			this.emit();
			// Text and structured data carry the same information: the text unless JSON was asked for.
			if (result.isError) return { text: result.text, isError: true, kind: result.kind ?? "error" };
			if (params.format === "json" && result.data !== undefined) return { text: JSON.stringify(result.data), data: result.data };
			return { text: result.text };
		} catch (error) {
			const kind = error instanceof AgentRefusal ? "refused" : error instanceof AgentUnavailable ? "unavailable" : "error";
			const message = error instanceof Error ? error.message : String(error);
			this.record(session, { operation: name, plugin, screen, outcome: kind === "refused" ? "denied" : "error", detail: message.slice(0, 300) });
			this.emit();
			return { text: message, isError: true, kind };
		}
	}

	// ── the registry of agent operations ──────────────────────────────────
	private defineOperations(): Operation[] {
		const str = (description: string) => ({ type: "string", description });
		const int = (description: string) => ({ type: "integer", minimum: 0, description });
		const format = { type: "string", enum: ["text", "json"], description: "text (default) is for reading; json returns the same information as structured data." };
		const access = this;
		return [
			{
				name: "toolbelt_status",
				title: "ToolBelt status",
				description:
					"What ToolBelt is running now: the app version and any app update, and each plugin agents can read with its state, badge, screens and any update. Start here. list_plugins is the installation view (disabled plugins, repositories, release channels).",
				risk: "read",
				params: { type: "object", properties: { format }, additionalProperties: false },
				run: async () => {
					const app = this.o.app();
					const update = this.o.appUpdate?.();
					const plugins = this.visible();
					const hidden = this.o.host.list().length - plugins.length;
					const lines = [
						`${app.name} ${app.version} (${app.channel}${app.developmentProfile ? `, plugin development profile ${app.developmentProfile}` : ""})${app.location ? `, answering from ${app.location} (process ${process.pid})` : ""}`,
						update?.available ? `App update available: ${update.available}` : `No app update available${update?.lastChecked ? ` (checked ${when(update.lastChecked, this.now())})` : ""}`,
						"",
						"Plugins agents can read:",
						...plugins.map((p) => `- ${p.name} (${p.id}) ${p.info.manifest.version}: ${p.info.state}${p.info.state !== "running" ? " (can't be read until the person restarts it)" : badgeOf(p.info) !== null ? `, badge ${badgeOf(p.info)}` : ""}${p.update ? `; update available: ${p.update}` : ""}. Screens: ${p.info.manifest.screens.map((s) => `${s.title} (${s.id})`).join(", ")}`),
						...(plugins.length ? [] : ["- none"]),
						...(hidden > 0 ? ["", `${hidden} more plugin${hidden === 1 ? " is" : "s are"} not available to agents (the plugin doesn't allow it, or the person hasn't).`] : []),
					];
					return {
						text: lines.join("\n"),
						data: {
							app: { ...app, location: app.location ?? null, pid: process.pid },
							update: update ? { ...update, lastCheckedIso: iso(update.lastChecked) } : null,
							plugins: plugins.map((p) => ({ id: p.id, name: p.name, version: p.info.manifest.version, state: p.info.state, badge: badgeOf(p.info), access: p.effective, availableVersion: p.update ?? null, screens: p.info.manifest.screens.map((s) => ({ id: s.id, title: s.title })) })),
							hiddenPlugins: Math.max(0, hidden),
						},
					};
				},
			},
			{
				name: "list_screens",
				title: "List screens",
				description: "Every plugin screen agents can read, as plugin and screen ids for read_screen.",
				risk: "read",
				params: { type: "object", properties: { plugin: str("Only this plugin's screens (plugin id)."), format }, additionalProperties: false },
				run: async (_s, params) => {
					const only = params.plugin !== undefined ? access.plugin(params.plugin).id : undefined;
					const screens = this.screens().filter((s) => only === undefined || s.plugin === only);
					return {
						text: screens.length ? screens.map((s) => `- ${s.pluginName} › ${s.title}: plugin "${s.plugin}", screen "${s.screen}"${s.default ? " (default)" : ""}${s.state !== "running" ? ` (unavailable: ${s.pluginName} is ${s.state})` : ""}`).join("\n") : "No screens are available to agents.",
						data: { screens },
					};
				},
			},
			{
				name: "read_screen",
				title: "Read a screen",
				description:
					"Read one plugin screen as the person would see it: tables with their rows and details, lists, forms, stats and logs, with times as absolute and relative. Search, filters and open dialogs are shared with people viewing the same screen, so the result notes any that apply. Long tables are paged.",
				risk: "read",
				params: {
					type: "object",
					properties: {
						plugin: str("Plugin id, from toolbelt_status or list_screens."),
						screen: str("Screen id; omit for the plugin's default screen."),
						format: { type: "string", enum: ["text", "json"], description: "text (default) is compact; json is the plugin's UI tree with the same metadata." },
						max_rows: int("Rows per table, nested rows included (default 50); 0 lists no rows, only each table's size and columns."),
						table: str("The table that `offset` pages."),
						offset: int("First row of `table` to return, counting top-level rows (or the `parent` row's children)."),
						parent: str("A row id in `table`: page that row's child rows (such as a process's children) with `offset` instead of the table's rows."),
						details: { type: "boolean", description: "Include each row's inspector details (default true)." },
					},
					required: ["plugin"],
					additionalProperties: false,
				},
				run: async (_s, params) => {
					const r = await this.readScreen(params.plugin, params.screen, {
						format: params.format === "json" ? "json" : "text",
						maxRows: typeof params.max_rows === "number" ? Math.max(0, Math.min(1000, Math.floor(params.max_rows))) : undefined,
						table: typeof params.table === "string" ? params.table : undefined,
						offset: typeof params.offset === "number" ? Math.max(0, Math.floor(params.offset)) : undefined,
						details: typeof params.details === "boolean" ? params.details : undefined,
						parent: typeof params.parent === "string" ? params.parent : undefined,
						// Set by the MCP adapter for resource reads, so paging hints name the URI to read.
						resource: typeof params._resource === "string" ? params._resource : undefined,
					});
					const age = r.at ? `rendered ${when(r.at, this.now()).replace(/^.*\((.*)\)$/, "$1")}` : "";
					const shared = r.viewState.length
						? `This screen's view is shared with the person and currently shows: ${r.viewState.join("; ")}. Rows outside it are not listed.`
						: "";
					const header = [`# ${r.ref.pluginName} › ${r.ref.title} (plugin "${r.ref.plugin}", screen "${r.ref.screen}")`, [age, r.watched ? "a person has it open" : ""].filter(Boolean).join("; "), shared].filter(Boolean).join("\n");
					const meta = { ...r.ref, rendered: r.rendered, renderedAt: r.at || null, renderedAtIso: iso(r.at), personViewing: r.watched, viewState: r.viewState };
					// JSON: the tree with the same metadata. Text: the screen as text (also as `text` in the data).
					return { text: `${header}\n\n${r.text}`, data: { ...meta, tree: r.tree } };
				},
			},
			{
				name: "search_screens",
				title: "Search all screens",
				description:
					"Find lines mentioning every word of a query across all screens agents can read (tasks, updates, notes, settings). Returns matching lines with their plugin, screen and section; read_screen gives the full context.",
				risk: "read",
				params: {
					type: "object",
					properties: { query: str("Words to look for (case-insensitive, all must appear on the line)."), plugin: str("Only this plugin."), format },
					required: ["query"],
					additionalProperties: false,
				},
				run: async (_s, params) => {
					const words = String(params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
					if (!words.length) throw new AgentRefusal("Give a query.");
					const only = params.plugin !== undefined ? access.plugin(params.plugin).id : undefined;
					const screens = this.screens().filter((s) => only === undefined || s.plugin === only);
					// A screen that can't be read is reported, never counted as searched.
					const failed: { plugin: string; screen: string; reason: string }[] = [];
					const reads = await Promise.all(
						screens.map(async (s) => {
							try {
								// The whole screen: search isn't bound by a read's size limit.
								const r = await this.readScreen(s.plugin, s.screen, { maxRows: 5000, budget: Number.MAX_SAFE_INTEGER });
								if (r.rendered) return r;
								failed.push({ plugin: s.plugin, screen: s.screen, reason: "it hasn't rendered yet" });
							} catch (error) {
								failed.push({ plugin: s.plugin, screen: s.screen, reason: error instanceof Error ? error.message : String(error) });
							}
							return null;
						}),
					);
					const searched = reads.filter((r) => r !== null).length;
					const hits: (SearchHit & { plugin: string; screen: string })[] = [];
					for (const r of reads) if (r) for (const hit of searchText(r.text, words)) hits.push({ plugin: r.ref.plugin, screen: r.ref.screen, ...hit, matched: hit.matched.slice(0, 5) });
					// Shown until the text's size limit, at most 40 hits of 3 matched lines each.
					const shown: typeof hits = [];
					let size = 0;
					for (const h of hits.slice(0, 40)) {
						size += h.line.length + h.matched.slice(0, 3).reduce((n, m) => n + m.length + 8, 0) + 80;
						if (size > TEXT_BUDGET / 2 && shown.length) break;
						shown.push(h);
					}
					const names = new Map(screens.map((s) => [`${s.plugin}/${s.screen}`, `${s.pluginName} › ${s.title}`]));
					const plural = (n: number) => `${n} screen${n === 1 ? "" : "s"}`;
					const lines = shown.length
						? [
								...shown.flatMap((h) => [
									`- ${names.get(`${h.plugin}/${h.screen}`)}${h.section ? ` › ${h.section}` : ""}: ${h.line}`,
									...h.matched.slice(0, 3).map((m) => `    ↳ ${m}`),
									...(h.matched.length > 3 ? [`    ↳ (${h.matched.length - 3} more matching lines; read_screen shows the row)`] : []),
								]),
								...(hits.length > shown.length ? [`(${hits.length - shown.length} more matches; narrow the query or pass plugin)`] : []),
							]
						: [searched ? `Nothing on ${plural(searched)} mentions "${words.join(" ")}".` : "No screen could be searched."];
					if (failed.length)
						lines.push(`${plural(failed.length)} couldn't be searched, so matches there are unknown:`, ...failed.map((f) => `- ${names.get(`${f.plugin}/${f.screen}`)}: ${f.reason}`));
					return {
						text: lines.join("\n"),
						data: { matches: hits.slice(0, 100), matchCount: hits.length, screensSearched: searched, failed },
					};
				},
			},
			{
				name: "list_plugins",
				title: "Installed plugins",
				description: "What's installed: every plugin agents may see, enabled or not, with its version, state, repository, release channel and any update. toolbelt_status is the runtime view (badges, screens).",
				risk: "read",
				params: { type: "object", properties: { format }, additionalProperties: false },
				run: async () => {
					const choices = this.o.settings().access;
					// The same words as toolbelt_status: `state` is the runtime state while enabled.
					const running = new Map(this.o.host.list().map((i) => [i.manifest.id, i.state]));
					const installed = (this.o.installed?.() ?? [])
						.map((p) => ({ ...p, access: effectiveAccess(p.declared, choices[p.id]) }))
						.filter((p) => p.access !== "none")
						.map((p) => ({
							id: p.id,
							name: p.name,
							version: p.version,
							state: p.enabled ? (running.get(p.id) ?? p.phase ?? "enabled") : "disabled",
							enabled: p.enabled,
							access: p.access,
							availableVersion: p.availableVersion ?? null,
							repo: p.repo ?? null,
							channel: p.channel ?? null,
						}));
					return {
						text: installed.length
							? installed.map((p) => `- ${p.name} (${p.id}) ${p.version}${p.repo ? ` from ${p.repo}` : ""}: ${p.state}${p.availableVersion ? `; update available: ${p.availableVersion}` : ""}${p.channel === "prerelease" ? " (prerelease channel)" : ""}`).join("\n")
							: "No plugins are available to agents.",
						data: { plugins: installed },
					};
				},
			},
		];
	}

	// ── Settings → Agents ─────────────────────────────────────────────────
	setRunning(running: boolean, error: string | null) {
		this.running = running;
		this.error = error;
		if (!running) for (const s of [...this.sessions.values()]) this.sessions.delete(s.id);
		this.emit();
	}

	state(auditLimit = 50): AgentsState {
		const s = this.o.settings();
		return {
			enabled: s.enabled,
			running: this.running,
			error: this.error,
			socket: this.o.socket,
			command: this.o.command,
			commandWarning: this.o.commandWarning ?? null,
			plugins: this.pluginsWithAccess().map(({ info: _info, ...p }) => p),
			sessions: [...this.sessions.values()],
			audit: this.audit.query({ limit: auditLimit }).entries,
		};
	}

	private emitTimer: ReturnType<typeof setTimeout> | undefined;
	private emit() {
		// Bursts (a search reads every screen) become one update.
		clearTimeout(this.emitTimer);
		this.emitTimer = setTimeout(() => this.o.changed(this.state()), 50);
	}

	/** Settings → Agents requests. `enable` starts or stops the transport. */
	handle(request: AgentsRequest, enable: (on: boolean) => void): AgentsState | AuditPage {
		const settings = this.o.settings();
		switch (request.operation) {
			case "read":
				return this.state();
			case "setEnabled":
				this.o.save({ ...settings, enabled: request.enabled === true });
				enable(request.enabled === true);
				return this.state();
			case "setAccess": {
				const access = { ...settings.access };
				if (request.access === null) delete access[request.plugin];
				else if (["none", "read", "act"].includes(request.access)) access[request.plugin] = request.access;
				else throw new Error("Invalid access");
				this.o.save({ ...settings, access });
				// Lowering access releases what the agent held of that plugin.
				for (const key of [...this.holds.keys()])
					if (key.startsWith(`${request.plugin}\n`) && !this.visible().some((p) => p.id === request.plugin)) {
						const h = this.holds.get(key)!;
						h.pins = 0;
						this.release(key);
					}
				this.pluginListeners.forEach((l) => l());
				return this.state();
			}
			case "audit":
				return this.audit.query({ limit: Math.max(1, Math.min(500, request.limit ?? 50)), before: request.before, after: request.after, filter: request.filter });
		}
	}

	/** Releases every surface the agent holds. */
	stop() {
		for (const key of [...this.holds.keys()]) {
			const h = this.holds.get(key)!;
			h.pins = 0;
			this.release(key);
		}
	}
}
