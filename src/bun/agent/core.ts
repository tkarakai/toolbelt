// The agent interface's core (docs/agents.md): sessions, per-plugin access, the agent's own view
// of plugin surfaces, the registry of agent operations, and the audit log. Transports (the MCP
// socket, the CLI) are adapters over `call`. Agents can only read in this version.
import type { Manifest, Node } from "../../shared/protocol";
import type { PluginInfo } from "../../shared/plugin-state";
import {
	atLeast,
	declaredAccess,
	effectiveAccess,
	type AgentAccess,
	type AgentMode,
	type AgentPlugin,
	type AgentSession,
	type AgentSettings,
	type AgentsRequest,
	type AgentsState,
	type AuditEntry,
} from "../../shared/agents";
import { AuditLog } from "./audit";
import { treeJson, treeText, when } from "./serialize";

/** The parts of PluginHost the agent interface uses. */
export type AgentHost = {
	list(): PluginInfo[];
	open(plugin: string, surface: string): unknown;
	close(plugin: string, surface: string): void;
	snapshot(plugin: string, surface: string): { tree: Node | null; at: number; viewers: number } | null;
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
	/** The manifest's `agent.access` ceiling. */
	ceiling: AgentAccess;
};

export type AgentCoreOptions = {
	host: AgentHost;
	settings(): AgentSettings;
	save(next: AgentSettings): void;
	app(): { name: string; version: string; channel: string; developmentProfile: string | null };
	appUpdate?(): { available: string | null; lastChecked: number | null };
	installed?(): InstalledSummary[];
	auditFile: string;
	socket: string;
	command: string[] | null;
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
export type CallResult = { text: string; data?: unknown; isError?: boolean };
export type Operation = {
	name: string;
	title: string;
	description: string;
	/** Every operation in this version is `read`. */
	risk: "read";
	params: Schema;
	run(session: AgentSession, params: Record<string, unknown>): Promise<CallResult>;
};

export class AgentRefusal extends Error {}
const UNAVAILABLE = (id: string) =>
	new AgentRefusal(`No plugin "${id}" is available to agents. Call list_screens to see what is.`);

export type ScreenRef = { plugin: string; screen: string; title: string; pluginName: string; default: boolean };

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
		return this.o.host.list().map((info) => {
			const ceiling = declaredAccess(info.manifest);
			const choice = choices[info.manifest.id];
			return {
				id: info.manifest.id,
				name: info.manifest.name,
				icon: info.manifest.icon,
				ceiling,
				choice,
				effective: effectiveAccess(ceiling, choice),
				declared: info.manifest.agent !== undefined,
				info,
			};
		});
	}

	/** Plugins agents may see at `needed` or above. */
	visible(needed: AgentAccess = "read") {
		return this.pluginsWithAccess().filter((p) => atLeast(p.effective, needed));
	}

	private plugin(id: unknown) {
		const p = typeof id === "string" ? this.visible().find((x) => x.id === id) : undefined;
		if (!p) throw UNAVAILABLE(String(id));
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

	/** One screen, read for an agent. Throws AgentRefusal when it isn't available. */
	async readScreen(pluginId: unknown, screenId: unknown, options: { format?: "text" | "json"; maxRows?: number; table?: string; offset?: number; details?: boolean } = {}) {
		const p = this.plugin(pluginId);
		const manifest = p.info.manifest as Manifest;
		const screen = screenId === undefined || screenId === null || screenId === ""
			? (manifest.screens.find((s) => s.default) ?? manifest.screens[0])
			: manifest.screens.find((s) => s.id === screenId);
		if (!screen)
			throw new AgentRefusal(`${p.name} has no screen "${String(screenId)}". Its screens: ${manifest.screens.map((s) => s.id).join(", ")}.`);
		if (p.info.state !== "running")
			throw new AgentRefusal(`${p.name} is ${p.info.state}${p.info.error ? `: ${p.info.error.split("\n")[0]}` : ""}.`);
		const snap = await this.fresh(p.id, `screen:${screen.id}`);
		const ref = { plugin: p.id, screen: screen.id, pluginName: p.name, title: screen.title };
		if (!snap?.tree) return { ref, tree: null, text: `${p.name} › ${screen.title} hasn't rendered yet. Try again in a moment.`, viewState: [] as string[], at: 0, watched: false };
		const shared = snap.viewers > 1; // someone besides the agent has it open
		if (options.format === "json")
			return { ref, tree: treeJson(snap.tree, { ...options, now: this.now() }), text: "", viewState: [] as string[], at: snap.at, watched: shared };
		const { text, viewState } = treeText(snap.tree, { ...options, now: this.now() });
		return { ref, tree: null, text, viewState, at: snap.at, watched: shared };
	}

	// ── sessions and audit ────────────────────────────────────────────────
	openSession(client: string, mode: AgentMode): AgentSession {
		const session = { id: crypto.randomUUID(), client: client.slice(0, 64) || "agent", mode, since: Date.now() };
		this.sessions.set(session.id, session);
		this.emit();
		return session;
	}
	renameSession(session: AgentSession, client: string) {
		session.client = client.slice(0, 64) || session.client;
		this.emit();
	}
	closeSession(session: AgentSession) {
		if (this.sessions.delete(session.id)) this.emit();
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
			return result;
		} catch (error) {
			const refused = error instanceof AgentRefusal;
			const message = error instanceof Error ? error.message : String(error);
			this.record(session, { operation: name, plugin, screen, outcome: refused ? "denied" : "error", detail: message.slice(0, 300) });
			this.emit();
			return { text: message, isError: true };
		}
	}

	// ── the registry of agent operations ──────────────────────────────────
	private defineOperations(): Operation[] {
		const str = (description: string) => ({ type: "string", description });
		const int = (description: string) => ({ type: "integer", minimum: 0, description });
		const access = this;
		return [
			{
				name: "toolbelt_status",
				title: "ToolBelt status",
				description:
					"What ToolBelt is running: the app version and any app update, and each plugin agents can see with its state and screens. Start here.",
				risk: "read",
				params: { type: "object", properties: {}, additionalProperties: false },
				run: async () => {
					const app = this.o.app();
					const update = this.o.appUpdate?.();
					const plugins = this.visible();
					const hidden = this.o.host.list().length - plugins.length;
					const lines = [
						`${app.name} ${app.version} (${app.channel}${app.developmentProfile ? `, plugin development profile ${app.developmentProfile}` : ""})`,
						update?.available ? `App update available: ${update.available}` : `No app update available${update?.lastChecked ? ` (checked ${when(update.lastChecked, this.now())})` : ""}`,
						"",
						"Plugins agents can read:",
						...plugins.map((p) => `- ${p.name} (${p.id}) ${p.info.manifest.version}: ${p.info.state}${p.info.badge !== null && p.info.badge !== undefined ? `, badge ${p.info.badge}` : ""}. Screens: ${p.info.manifest.screens.map((s) => `${s.title} (${s.id})`).join(", ")}`),
						...(plugins.length ? [] : ["- none"]),
						...(hidden > 0 ? ["", `${hidden} more plugin${hidden === 1 ? " is" : "s are"} not available to agents (the plugin or the person turned agent access off).`] : []),
					];
					return {
						text: lines.join("\n"),
						data: {
							app,
							update: update ?? null,
							plugins: plugins.map((p) => ({ id: p.id, name: p.name, version: p.info.manifest.version, state: p.info.state, badge: p.info.badge, access: p.effective, screens: p.info.manifest.screens.map((s) => ({ id: s.id, title: s.title })) })),
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
				params: { type: "object", properties: { plugin: str("Only this plugin's screens (plugin id).") }, additionalProperties: false },
				run: async (_s, params) => {
					if (params.plugin !== undefined) access.plugin(params.plugin);
					const screens = this.screens().filter((s) => params.plugin === undefined || s.plugin === params.plugin);
					return {
						text: screens.length ? screens.map((s) => `- ${s.pluginName} › ${s.title}: plugin "${s.plugin}", screen "${s.screen}"${s.default ? " (default)" : ""}`).join("\n") : "No screens are available to agents.",
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
						format: { type: "string", enum: ["text", "json"], description: "text (default) is compact; json is the plugin's UI tree." },
						max_rows: int("Rows per table (default 100)."),
						table: str("The table that `offset` pages."),
						offset: int("First row of `table` to return."),
						details: { type: "boolean", description: "Include each row's inspector details (default true)." },
					},
					required: ["plugin"],
					additionalProperties: false,
				},
				run: async (_s, params) => {
					const r = await this.readScreen(params.plugin, params.screen, {
						format: params.format === "json" ? "json" : "text",
						maxRows: typeof params.max_rows === "number" ? Math.max(1, Math.min(1000, params.max_rows)) : undefined,
						table: typeof params.table === "string" ? params.table : undefined,
						offset: typeof params.offset === "number" ? params.offset : undefined,
						details: typeof params.details === "boolean" ? params.details : undefined,
					});
					const age = r.at ? `rendered ${when(r.at).replace(/^.*\((.*)\)$/, "$1")}` : "";
					const shared = r.viewState.length
						? `This screen's view is shared with the person and currently shows: ${r.viewState.join("; ")}. Rows outside it are not listed.`
						: "";
					const header = [`# ${r.ref.pluginName} › ${r.ref.title} (plugin "${r.ref.plugin}", screen "${r.ref.screen}")`, [age, r.watched ? "a person has it open" : ""].filter(Boolean).join("; "), shared].filter(Boolean).join("\n");
					if (r.tree) return { text: `${header}\n\n${JSON.stringify(r.tree)}`, data: { ...r.ref, renderedAt: r.at, viewState: r.viewState, tree: r.tree } };
					return { text: `${header}\n\n${r.text}`, data: { ...r.ref, renderedAt: r.at, viewState: r.viewState } };
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
					properties: { query: str("Words to look for (case-insensitive, all must appear on the line)."), plugin: str("Only this plugin.") },
					required: ["query"],
					additionalProperties: false,
				},
				run: async (_s, params) => {
					const words = String(params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
					if (!words.length) throw new AgentRefusal("Give a query.");
					if (params.plugin !== undefined) access.plugin(params.plugin);
					const screens = this.screens().filter((s) => params.plugin === undefined || s.plugin === params.plugin);
					const reads = await Promise.all(
						screens.map((s) => this.readScreen(s.plugin, s.screen, { maxRows: 1000 }).catch(() => null)),
					);
					const hits: { plugin: string; screen: string; section: string; line: string }[] = [];
					for (const r of reads) {
						if (!r) continue;
						let section = "";
						for (const line of r.text.split("\n")) {
							if (/^#{2,3} /.test(line)) section = line.replace(/^#+ /, "");
							// Content only: not the screen's controls (actions, filters, columns, headings).
							if (/^(#|Columns:|Row actions:|Bulk actions:|Toolbar actions:|Actions:|Filter |Control |Empty sections:|\(showing)/.test(line.trim())) continue;
							if (words.every((w) => line.toLowerCase().includes(w)))
								hits.push({ plugin: r.ref.plugin, screen: r.ref.screen, section, line: line.trim() });
						}
					}
					const shown = hits.slice(0, 60);
					const names = new Map(screens.map((s) => [`${s.plugin}/${s.screen}`, `${s.pluginName} › ${s.title}`]));
					return {
						text: shown.length
							? [
									...shown.map((h) => `- ${names.get(`${h.plugin}/${h.screen}`)}${h.section ? ` › ${h.section}` : ""}: ${h.line}`),
									...(hits.length > shown.length ? [`(${hits.length - shown.length} more matches; narrow the query or pass plugin)`] : []),
								].join("\n")
							: `Nothing on ${screens.length} screen${screens.length === 1 ? "" : "s"} mentions "${words.join(" ")}".`,
						data: { matches: hits.slice(0, 200), screensSearched: screens.length },
					};
				},
			},
			{
				name: "list_plugins",
				title: "Installed plugins",
				description: "Installed plugins agents can see: version, repository, enabled or not, and any update available.",
				risk: "read",
				params: { type: "object", properties: {}, additionalProperties: false },
				run: async () => {
					const choices = this.o.settings().access;
					const installed = (this.o.installed?.() ?? []).filter((p) => effectiveAccess(p.ceiling, choices[p.id]) !== "none");
					return {
						text: installed.length
							? installed.map((p) => `- ${p.name} (${p.id}) ${p.version}${p.repo ? ` from ${p.repo}` : ""}: ${p.enabled ? (p.phase ?? "enabled") : "disabled"}${p.availableVersion ? `; update available: ${p.availableVersion}` : ""}${p.channel === "prerelease" ? " (prerelease channel)" : ""}`).join("\n")
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
			plugins: this.pluginsWithAccess().map(({ info: _info, ...p }) => p),
			sessions: [...this.sessions.values()],
			audit: this.audit.read(auditLimit),
		};
	}

	private emitTimer: ReturnType<typeof setTimeout> | undefined;
	private emit() {
		// Bursts (a search reads every screen) become one update.
		clearTimeout(this.emitTimer);
		this.emitTimer = setTimeout(() => this.o.changed(this.state()), 50);
	}

	/** Settings → Agents requests. `enable` starts or stops the transport. */
	handle(request: AgentsRequest, enable: (on: boolean) => void): AgentsState | { entries: AuditEntry[] } {
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
				return { entries: this.audit.read(Math.min(500, request.limit ?? 50), request.before) };
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
