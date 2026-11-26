// The agent interface's core (docs/agent-interface.md): sessions, per-plugin access, the agent's own view
// of plugin surfaces, the registry of agent operations, and the audit log. Transports (the MCP
// socket, the CLI) are adapters over `call`. Agents read through private instances of each
// surface with a view of their own; the one thing they change is the person's view
// (`show_screen`), under a grant the person gives on their own screens.
import { PERSON, type Manifest, type Node, type Row, type ViewDeclaration, type ViewState } from "../../shared/protocol";
import type { PluginInfo } from "../../shared/plugin-state";
import { cleanView } from "../../shared/views";
import {
	atLeast,
	DEFAULT_GRANT,
	declaredAccess,
	effectiveAccess,
	grantEnd,
	GRANT_DURATIONS,
	type AgentAccess,
	type AgentMode,
	type AgentPlugin,
	type AgentSession,
	type AgentSettings,
	type AgentsRequest,
	type AgentsState,
	type AuditEntry,
	type AuditPage,
	type GrantDuration,
	type ShownView,
	type ViewApproval,
	type ViewGrant,
} from "../../shared/agents";
import { AuditLog } from "./audit";
import { findRow, searchText, treeJson, treeText, TEXT_BUDGET, when, type SearchHit } from "./serialize";

/** The parts of PluginHost the agent interface uses. Instances default to the person's. */
export type AgentHost = {
	list(): PluginInfo[];
	open(plugin: string, surface: string, instance?: string, view?: ViewState): unknown;
	close(plugin: string, surface: string, instance?: string): void;
	/** The instance's cached tree; `error` when its last render was rejected (the tree is then null). */
	snapshot(plugin: string, surface: string, instance?: string): { tree: Node | null; at: number; viewers: number; error?: string } | null;
	/** The surface's view declaration from the plugin's handshake. */
	declaredView(plugin: string, surface: string): ViewDeclaration | null;
	subscribe(listener: {
		plugins(list: PluginInfo[]): void;
		tree(plugin: string, surface: string, tree: Node, instance: string): void;
		toast(): void;
		view?(plugin: string, surface: string, view: ViewState): void;
	}): () => void;
};

/** A device that can show ToolBelt: the Mac's window, or a paired device with ToolBelt open. */
export type PersonDevice = { name: string; kind: "mac" | "device"; showing: boolean };

/** The person's screens, for `show_screen`: provided by the app, absent in tests that don't need it. */
export type PersonScreens = {
	/** The Mac (whether its window is open) and each paired device (whether it has ToolBelt open). */
	devices(): PersonDevice[];
	/** Opens the main window on the Mac. */
	openWindow(): void;
	/** Shows a plugin screen on every person's screen that is open. */
	navigate(plugin: string, screen: string): void;
	/** The person's current view of a surface. */
	view(plugin: string, surface: string): ViewState;
	/** Sets the person's view of a surface: applied at once where it's open, else saved for next time. */
	setView(plugin: string, surface: string, view: ViewState): void;
};

/** What an agent asks to see: the person's own view, or its own (declared defaults overlaid). */
export type ViewInput = "person" | { search?: string; filters?: Record<string, string[]>; sort?: Record<string, string>; controls?: Record<string, string> };

export type InstalledSummary = {
	id: string;
	name: string;
	version: string;
	repo?: string;
	enabled: boolean;
	phase?: string;
	availableVersion?: string;
	channel?: string;
	/** The manifest's `agent.access`. */
	declared: AgentAccess;
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
	/** The person's screens; without them `show_screen` is unavailable. */
	person?: PersonScreens;
	/** How long `show_screen` waits for the person to answer (ms). Default 60 s. */
	approvalMs?: number;
};

/** JSON Schema, as MCP tools declare their input. */
type Schema = Record<string, unknown>;
/**
 * An operation's result. `data` is the same information as structured data: it is returned (as MCP
 * `structuredContent`, and as the text) only when the caller asks for `format: "json"`. `kind`
 * says why a call failed: refused (unknown or hidden), unavailable (the plugin can't be read
 * now) or another error.
 */
export type CallResult = { text: string; data?: unknown; isError?: boolean; kind?: "refused" | "invalid" | "unavailable" | "error" };
export type Operation = {
	name: string;
	title: string;
	description: string;
	/** `read` changes nothing; `view` changes only what the person's screens show. */
	risk: "read" | "view";
	params: Schema;
	run(session: AgentSession, params: Record<string, unknown>): Promise<CallResult>;
};

/** The agent asked for something it can't have or that doesn't exist: audited as `denied`. */
export class AgentRefusal extends Error {}
/** A view the screen doesn't offer (an unknown filter, option, column or control): audited as `denied`. */
export class ViewRefusal extends AgentRefusal {}
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

/** The agent instance for a view: one per distinct view, shared by sessions asking the same. */
function instanceOf(view: ViewState): string {
	const canonical = (v: unknown): unknown =>
		Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
	const json = JSON.stringify(canonical(view));
	if (json === "{}") return "agent:default";
	return `agent:${new Bun.CryptoHasher("sha256").update(json).digest("hex").slice(0, 16)}`;
}

/** A sort as agents write it: `"due"` ascending, `"-due"` descending. */
const sortText = (s: { key: string; desc: boolean } | null | undefined) => (s ? `${s.desc ? "-" : ""}${s.key}` : null);

/** A page's view controls as agents see them: ids from the declaration, options from a rendered tree. */
export type ViewSchema = {
	search: boolean;
	filters: { id: string; label: string; default: string[]; options: { value: string; label: string }[] | null }[];
	sort: { table: string; default: string | null; keys: string[] | null }[];
	controls: { id: string; label: string; default: string; options: string[] | null }[];
};

/** A table node by id, anywhere in a tree. */
function tableNode(tree: unknown, id: string): Extract<Node, { type: "table" }> | undefined {
	return tableOf(tree, id) as Extract<Node, { type: "table" }> | undefined;
}

/** The `view` parameter of read_screen and show_screen. */
const VIEW_PARAM = {
	description:
		'Search, filter and sort the screen in this read, as the person would in ToolBelt (list_screens shows each screen\'s view controls): {"search": "text", "filters": {"<filter id>": ["<option value>", …]}, "sort": {"<table id>": "<column key>" or "-<column key>"}, "controls": {"<control id>": "<value>"}}. Unset parts keep the screen\'s defaults; an empty filter list means all. Or "person" for exactly what the person\'s screens show now.',
	anyOf: [
		{ type: "string", enum: ["person"] },
		{
			type: "object",
			properties: {
				search: { type: "string" },
				filters: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
				sort: { type: "object", additionalProperties: { type: "string" } },
				controls: { type: "object", additionalProperties: { type: "string" } },
			},
			additionalProperties: false,
		},
	],
};

/** A screen's view controls on one line, after its list_screens entry. */
function schemaText(v: ViewSchema) {
	const parts = [
		...(v.search ? ["search"] : []),
		...v.filters.map((f) => `filter "${f.id}"${f.options ? ` [${f.options.map((o) => o.value).join(", ")}]` : ""}${f.default.length ? ` (default ${f.default.join(", ")})` : ""}`),
		...v.sort.map((t) => `sort "${t.table}"${t.keys ? ` by ${t.keys.join(", ")}` : ""}${t.default ? ` (default ${t.default})` : ""}`),
		...v.controls.map((c) => `control "${c.id}"${c.options ? ` [${c.options.join(", ")}]` : ""} (default ${c.default})`),
	];
	return parts.length ? `\n    view: ${parts.join("; ")}` : "";
}

export type ScreenRef = { plugin: string; screen: string; title: string; pluginName: string; default: boolean; /** The plugin's state: only running plugins can be read. */ state: string };

export class AgentCore {
	private sessions = new Map<string, AgentSession>();
	private audit: AuditLog;
	/** Surfaces the agent holds open: key → release timer (null while a subscription pins it). */
	private holds = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pins: number }>();
	private waiters = new Set<{ plugin: string; surface: string; instance: string; done: () => void }>();
	private treeListeners = new Set<(plugin: string, surface: string, instance: string) => void>();
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
			tree: (plugin, surface, _tree, instance = PERSON) => {
				for (const w of [...this.waiters]) if (w.plugin === plugin && w.surface === surface && w.instance === instance) w.done();
				this.treeListeners.forEach((l) => l(plugin, surface, instance));
			},
			toast: () => {},
			view: (plugin, surface, view) => this.personViewChanged(plugin, surface, view),
		});
		this.operations = this.defineOperations();
	}

	// ── access ───────────────────────────────────────────────────────────
	private pluginsWithAccess(): (AgentPlugin & { info: PluginInfo; update?: string })[] {
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
				ceiling: declared,
				choice,
				effective: effectiveAccess(declared, choice),
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

	// ── the agent's view: instances opened on demand, released when idle ─
	private key = (plugin: string, surface: string, instance: string) => `${plugin}\n${surface}\n${instance}`;

	private hold(plugin: string, surface: string, instance: string, view: ViewState, pin = false) {
		const key = this.key(plugin, surface, instance);
		let h = this.holds.get(key);
		if (!h) {
			h = { timer: null, pins: 0 };
			this.holds.set(key, h);
			this.o.host.open(plugin, surface, instance, instance === PERSON ? undefined : view);
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
		const [plugin, surface, instance] = key.split("\n");
		this.o.host.close(plugin, surface, instance);
	}

	/**
	 * Keeps a screen's instance open while something watches it (an MCP resource subscription).
	 * Returns the instance it watches, to match tree updates, and how to stop.
	 */
	watch(pluginId: string, screenId: string, view?: ViewInput) {
		const { p, screen } = this.screenOf(pluginId, screenId);
		const surface = `screen:${screen.id}`;
		const { instance, state } = this.viewFor(p.id, surface, view);
		this.hold(p.id, surface, instance, state, true);
		const key = this.key(p.id, surface, instance);
		return {
			plugin: p.id,
			surface,
			instance,
			stop: () => {
				const h = this.holds.get(key);
				if (!h) return;
				h.pins = Math.max(0, h.pins - 1);
				if (!h.pins) h.timer = setTimeout(() => this.release(key), this.o.holdMs ?? 60_000);
			},
		};
	}

	onTree(listener: (plugin: string, surface: string, instance: string) => void) {
		this.treeListeners.add(listener);
		return () => void this.treeListeners.delete(listener);
	}
	onPlugins(listener: () => void) {
		this.pluginListeners.add(listener);
		return () => void this.pluginListeners.delete(listener);
	}

	/** An instance's current tree, opening it first and waiting briefly if nobody was watching it. */
	async fresh(plugin: string, surface: string, instance: string = PERSON, view: ViewState = {}) {
		const before = this.o.host.snapshot(plugin, surface, instance);
		const watched = (before?.viewers ?? 0) > 0 && !!before?.tree;
		const pending = watched
			? null
			: new Promise<void>((resolve) => {
					const w = { plugin, surface, instance, done: () => (this.waiters.delete(w), resolve()) };
					this.waiters.add(w);
					setTimeout(w.done, this.o.renderWaitMs ?? 4000);
				});
		this.hold(plugin, surface, instance, view);
		await pending;
		return this.o.host.snapshot(plugin, surface, instance);
	}

	/** A visible plugin's screen by id or title; refuses with close matches. */
	private screenOf(pluginId: unknown, screenId: unknown) {
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
		return { p, screen };
	}

	/** A screen's view controls: ids and defaults from the declaration, options from its latest tree. */
	viewSchema(plugin: string, surface: string): ViewSchema | null {
		const declared = this.o.host.declaredView(plugin, surface);
		if (!declared) return null;
		const tree = this.o.host.snapshot(plugin, surface, PERSON)?.tree ?? this.o.host.snapshot(plugin, surface, "agent:default")?.tree ?? null;
		const page = tree?.type === "page" ? tree : null;
		return {
			search: !!declared.search,
			filters: Object.entries(declared.filters ?? {}).map(([id, def]) => {
				const f = page?.filters?.find((x) => x.id === id);
				return { id, label: f?.label ?? id, default: def, options: f ? f.options.map((o) => ({ value: o.value, label: o.label })) : null };
			}),
			sort: Object.entries(declared.sort ?? {}).map(([table, def]) => {
				const t = tableNode(tree, table);
				return { table, default: sortText(def), keys: t ? t.columns.filter((c) => c.sortable).map((c) => c.key) : null };
			}),
			controls: Object.entries(declared.controls ?? {}).map(([id, def]) => {
				const c = page?.controls?.find((x) => x.id === id);
				return { id, label: c?.label ?? id, default: def, options: c ? c.options.map((o) => o.value) : null };
			}),
		};
	}

	/**
	 * The instance and view state for what the agent asked: the person's instance for "person",
	 * else an agent instance for the declared defaults overlaid with the agent's choices. Refuses
	 * view controls the screen doesn't declare, listing the ones it does.
	 */
	private viewFor(plugin: string, surface: string, input: ViewInput | undefined): { instance: string; state: ViewState } {
		if (input === "person") return { instance: PERSON, state: {} };
		const state = this.viewState(plugin, surface, input);
		return { instance: instanceOf(state), state };
	}

	/** An agent's view input as a view state, checked against the screen's declaration. */
	viewState(plugin: string, surface: string, input: ViewInput | undefined): ViewState {
		if (input === undefined || input === "person") return {};
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new ViewRefusal('view must be "person" or an object with search, filters, sort and controls.');
		const declared = this.o.host.declaredView(plugin, surface) ?? {};
		const schema = this.viewSchema(plugin, surface);
		const has = (o: object | undefined, id: string) => !!o && Object.hasOwn(o, id);
		const list = (ids: string[]) => (ids.length ? ids.join(", ") : "none");
		const unknown = Object.keys(input).filter((k) => !["search", "filters", "sort", "controls"].includes(k));
		if (unknown.length) throw new ViewRefusal(`Unknown view field ${unknown.join(", ")}: use search, filters, sort and controls.`);
		if (input.search !== undefined && (typeof input.search !== "string" || !declared.search)) throw new ViewRefusal(declared.search ? "view.search must be text." : "This screen has no search.");
		for (const [id, values] of Object.entries(input.filters ?? {})) {
			if (!has(declared.filters, id)) throw new ViewRefusal(`This screen has no filter "${id}". Its filters: ${list(Object.keys(declared.filters ?? {}))}.`);
			if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) throw new ViewRefusal(`view.filters.${id} must be a list of option values${schema ? ` (${schema.filters.find((f) => f.id === id)?.options?.map((o) => o.value).join(", ") ?? "read the screen for them"})` : ""}; [] means all.`);
		}
		const sort: Record<string, { key: string; desc: boolean }> = {};
		for (const [table, value] of Object.entries(input.sort ?? {})) {
			if (!has(declared.sort, table)) throw new ViewRefusal(`This screen has no sortable table "${table}". Sortable tables: ${list(Object.keys(declared.sort ?? {}))}.`);
			if (typeof value !== "string" || !value.replace(/^-/, "")) throw new ViewRefusal(`view.sort.${table} must be a column key, with "-" in front for descending ("-due").`);
			sort[table] = { key: value.replace(/^-/, ""), desc: value.startsWith("-") };
		}
		for (const [id, value] of Object.entries(input.controls ?? {})) {
			if (!has(declared.controls, id)) throw new ViewRefusal(`This screen has no control "${id}". Its controls: ${list(Object.keys(declared.controls ?? {}))}.`);
			if (typeof value !== "string") throw new ViewRefusal(`view.controls.${id} must be one of its option values.`);
		}
		return cleanView(declared, { search: input.search, filters: input.filters, sort, controls: input.controls });
	}

	/** Refuses option values the rendered instance doesn't offer, with the ones it does. */
	private checkValues(tree: Node, state: ViewState) {
		const page = tree.type === "page" ? tree : null;
		for (const [id, values] of Object.entries(state.filters ?? {})) {
			const f = page?.filters?.find((x) => x.id === id);
			const bad = f ? values.filter((v) => !f.options.some((o) => o.value === v)) : [];
			if (f && bad.length) throw new ViewRefusal(`Filter "${id}" has no option ${bad.map((b) => `"${b}"`).join(", ")}. Its options: ${f.options.map((o) => `${o.value} (${o.label})`).join(", ")}.`);
		}
		for (const [id, value] of Object.entries(state.controls ?? {})) {
			const c = page?.controls?.find((x) => x.id === id);
			if (c && !c.options.some((o) => o.value === value)) throw new ViewRefusal(`Control "${id}" has no option "${value}". Its options: ${c.options.map((o) => o.value).join(", ")}.`);
		}
		for (const [table, s] of Object.entries(state.sort ?? {})) {
			const t = tableNode(tree, table);
			const keys = t?.columns.filter((c) => c.sortable).map((c) => c.key) ?? [];
			if (t && !keys.includes(s.key)) throw new ViewRefusal(`Table "${table}" can't be sorted by "${s.key}". Sortable columns: ${keys.join(", ") || "none"}.`);
		}
	}

	/** A view state as a short phrase: `search "x"; Status: Done; sorted by -due`. */
	describeView(plugin: string, surface: string, state: ViewState) {
		const schema = this.viewSchema(plugin, surface);
		const parts: string[] = [];
		if (state.search) parts.push(`search "${state.search}"`);
		for (const [id, values] of Object.entries(state.filters ?? {})) {
			const f = schema?.filters.find((x) => x.id === id);
			parts.push(`${f?.label ?? id}: ${values.length ? values.map((v) => f?.options?.find((o) => o.value === v)?.label ?? v).join(", ") : "all"}`);
		}
		for (const [table, s] of Object.entries(state.sort ?? {})) parts.push(`${table} sorted by ${sortText(s)}`);
		for (const [id, value] of Object.entries(state.controls ?? {})) parts.push(`${schema?.controls.find((c) => c.id === id)?.label ?? id}: ${value}`);
		return parts.join("; ");
	}

	/** One screen, read for an agent. Throws AgentRefusal when it isn't available, AgentUnavailable when it can't be read now. */
	async readScreen(pluginId: unknown, screenId: unknown, options: { format?: "text" | "json"; maxRows?: number; table?: string; offset?: number; details?: boolean; budget?: number; parent?: string; resource?: string; view?: ViewInput } = {}) {
		const { p, screen } = this.screenOf(pluginId, screenId);
		if (p.info.state !== "running")
			throw new AgentUnavailable(`${p.name} is ${p.info.state}${p.info.error ? `: ${p.info.error.split("\n")[0]}` : ""}. The person can restart it in ToolBelt.`);
		const surface = `screen:${screen.id}`;
		const { instance, state } = this.viewFor(p.id, surface, options.view);
		const snap = await this.fresh(p.id, surface, instance, state);
		const person = this.o.host.snapshot(p.id, surface, PERSON);
		// Someone besides the agent has the person's view open.
		const personViewing = (person?.viewers ?? 0) - (this.holds.has(this.key(p.id, surface, PERSON)) ? 1 : 0) > 0;
		const ref = { plugin: p.id, screen: screen.id, pluginName: p.name, title: screen.title };
		const viewOf = { view: instance === PERSON ? ("person" as const) : ("agent" as const), viewSummary: instance === PERSON ? "" : this.describeView(p.id, surface, state) };
		if (snap?.error) throw new AgentUnavailable(`${p.name} › ${screen.title} couldn't be shown: ${snap.error}`);
		if (!snap?.tree) return { ref, ...viewOf, tree: null, rendered: false, text: `${p.name} › ${screen.title} hasn't rendered yet. Try again in a moment.`, viewState: [] as string[], at: 0, watched: personViewing };
		if (instance !== PERSON) this.checkValues(snap.tree, state);
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
		// Only the person's view has state someone set; an agent's own view is what it asked for.
		const notes = (tree: Node) => (instance === PERSON ? treeText(tree, { maxRows: 0, details: false }).viewState : []);
		if (options.format === "json") return { ref, ...viewOf, tree: treeJson(snap.tree, read), rendered: true, text: "", viewState: notes(snap.tree), at: snap.at, watched: personViewing };
		const { text, viewState } = treeText(snap.tree, read);
		return { ref, ...viewOf, tree: null, rendered: true, text, viewState: instance === PERSON ? viewState : [], at: snap.at, watched: personViewing };
	}

	// ── the person's view: grants, approvals, show and restore ─────────────
	private sessionGrants = new Map<string, ViewGrant & { session: string }>();
	private approvals = new Map<string, ViewApproval & { session: string; resolve: (answer: { allow: boolean; duration?: GrantDuration } | null) => void }>();
	/** Screens an agent changed: what the person's view was before, and what it was set to. */
	private shown = new Map<string, ShownView & { previous: ViewState; set: ViewState }>();

	/** Grants in force: saved ones not yet ended, and this-session ones of live sessions. */
	private grants(): (ViewGrant & { session?: string })[] {
		const now = Date.now();
		return [...this.o.settings().grants.filter((g) => g.until > now), ...this.sessionGrants.values()];
	}

	private granted(session: AgentSession) {
		return this.grants().some((g) => g.client === session.client && (g.session === undefined || g.session === session.id));
	}

	/** Asks every person's screen; resolves with the answer, or null when nobody answered in time. */
	private ask(session: AgentSession, what: string) {
		const id = crypto.randomUUID();
		const wait = this.o.approvalMs ?? 60_000;
		return new Promise<{ allow: boolean; duration?: GrantDuration } | null>((resolve) => {
			const timer = setTimeout(() => finish(null), wait);
			const finish = (answer: { allow: boolean; duration?: GrantDuration } | null) => {
				clearTimeout(timer);
				if (this.approvals.delete(id)) this.emit();
				resolve(answer);
			};
			this.approvals.set(id, { id, client: session.client, mode: session.mode, what, at: Date.now(), expires: Date.now() + wait, session: session.id, resolve: finish });
			this.emit();
		});
	}

	private grant(session: AgentSession, duration: GrantDuration) {
		const now = Date.now();
		const until = grantEnd(duration, now);
		if (until === null) {
			this.sessionGrants.set(session.id, { client: session.client, granted: now, until: Number.MAX_SAFE_INTEGER, duration, session: session.id });
			return;
		}
		const settings = this.o.settings();
		this.o.save({ ...settings, grants: [...settings.grants.filter((g) => g.client !== session.client && g.until > now), { client: session.client, granted: now, until, duration }] });
	}

	/** Changes the person's view of a screen and shows it on their open screens, after any approval. */
	private async show(session: AgentSession, params: Record<string, unknown>) {
		const person = this.o.person;
		if (!person) throw new AgentUnavailable("This ToolBelt can't show screens to the person.");
		const { p, screen } = this.screenOf(params.plugin, params.screen);
		if (p.info.state !== "running") throw new AgentUnavailable(`${p.name} is ${p.info.state}. The person can restart it in ToolBelt.`);
		const surface = `screen:${screen.id}`;
		const input = params.view as ViewInput | undefined;
		if (input === "person") throw new ViewRefusal('view: "person" is the person\'s current view already; pass the view to show, or omit it to show the screen as it is.');
		const state = input === undefined ? null : this.viewState(p.id, surface, input);
		// The view must render with options the plugin offers before it reaches the person.
		if (state) {
			const snap = await this.fresh(p.id, surface, instanceOf(state), state);
			if (snap?.tree) this.checkValues(snap.tree, state);
		}
		const what = `${p.name} › ${screen.title}${state ? (this.describeView(p.id, surface, state) ? `, ${this.describeView(p.id, surface, state)}` : ", as it starts") : ""}`;
		const openWindow = params.open_window === true;
		const devices = () => person.devices();
		const canAsk = () => devices().some((d) => d.showing);
		if (!this.granted(session)) {
			if (!canAsk() && openWindow) person.openWindow();
			if (!canAsk() && !openWindow)
				throw new AgentRefusal(
					`Nobody can approve this: ${this.deviceText(devices())}. Tell the person, and ask whether to open ToolBelt's window on the Mac (call show_screen again with open_window: true) or wait until they open ToolBelt.`,
				);
			const answer = await this.ask(session, what);
			if (!answer) {
				this.record(session, { operation: "view_grant", plugin: p.id, screen: screen.id, outcome: "denied", detail: "no answer in time" });
				throw new AgentRefusal(`The person didn't answer within ${Math.round((this.o.approvalMs ?? 60_000) / 1000)} seconds, so nothing changed. Ask them whether to try again.`);
			}
			if (!answer.allow) {
				this.record(session, { operation: "view_grant", plugin: p.id, screen: screen.id, outcome: "denied", detail: "the person said no" });
				throw new AgentRefusal("The person didn't allow changing their view. Nothing changed.");
			}
			const duration = GRANT_DURATIONS.some((d) => d.id === answer.duration) ? answer.duration! : DEFAULT_GRANT;
			this.grant(session, duration);
			this.record(session, { operation: "view_grant", plugin: p.id, screen: screen.id, outcome: "ok", detail: `allowed for ${GRANT_DURATIONS.find((d) => d.id === duration)!.label.toLowerCase()}` });
		}
		const key = `${p.id}\n${surface}`;
		if (state) {
			const previous = this.shown.get(key)?.previous ?? person.view(p.id, surface);
			this.shown.set(key, { plugin: p.id, surface, client: session.client, at: Date.now(), previous, set: state });
			person.setView(p.id, surface, state);
		}
		if (openWindow && !devices().some((d) => d.kind === "mac" && d.showing)) person.openWindow();
		person.navigate(p.id, screen.id);
		this.emit();
		const now = devices();
		const showing = now.filter((d) => d.showing);
		const missing = now.filter((d) => !d.showing);
		const lines = [
			`Showing ${what} on ${showing.length ? showing.map((d) => d.name).join(", ") : "no screen right now"}.`,
			...(state ? ["The person's view stays this way until they change it; their screen offers Restore to put back what they had."] : []),
			...(missing.length
				? [`Not showing on ${missing.map((d) => `${d.name} (${d.kind === "mac" ? "window closed" : "ToolBelt not open"})`).join(", ")}. Tell the person and ask what to do${missing.some((d) => d.kind === "mac") ? "; open_window: true opens the window on the Mac" : ""}. A device shows it when it opens ToolBelt.`]
				: []),
		];
		return { text: lines.join("\n"), data: { plugin: p.id, screen: screen.id, view: state, shown: what, showing: showing.map((d) => d.name), notShowing: missing.map((d) => ({ name: d.name, kind: d.kind })) } };
	}

	private deviceText(devices: PersonDevice[]) {
		const devicesOff = devices.filter((d) => d.kind === "device");
		return `ToolBelt's window is closed on the Mac${devicesOff.length ? ` and ${devicesOff.map((d) => d.name).join(", ")} ${devicesOff.length === 1 ? "doesn't" : "don't"} have ToolBelt open` : " and no paired device has ToolBelt open"}`;
	}

	/** The person's view changed: a change they made themselves ends the agent's "Shown by" notice. */
	private personViewChanged(plugin: string, surface: string, view: ViewState) {
		const key = `${plugin}\n${surface}`;
		const shown = this.shown.get(key);
		if (!shown) return;
		const declared = this.o.host.declaredView(plugin, surface) ?? undefined;
		if (JSON.stringify(cleanView(declared, view)) === JSON.stringify(cleanView(declared, shown.set))) return;
		this.shown.delete(key);
		this.emit();
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
		if (this.sessions.get(session.id) === session && this.sessions.delete(session.id)) {
			// "This session" grants end with it; a question it was waiting on goes away.
			this.sessionGrants.delete(session.id);
			for (const a of [...this.approvals.values()]) if (a.session === session.id) a.resolve(null);
			this.emit();
		}
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
			const kind = error instanceof ViewRefusal ? "invalid" : error instanceof AgentRefusal ? "refused" : error instanceof AgentUnavailable ? "unavailable" : "error";
			const message = error instanceof Error ? error.message : String(error);
			this.record(session, { operation: name, plugin, screen, outcome: kind === "refused" || kind === "invalid" ? "denied" : "error", detail: message.slice(0, 300) });
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
				description: "Every plugin screen agents can read, as plugin and screen ids for read_screen, with each screen's view controls: its search, filters (with option values once the screen has rendered), sortable tables and page controls, to pass as read_screen's view.",
				risk: "read",
				params: { type: "object", properties: { plugin: str("Only this plugin's screens (plugin id)."), format }, additionalProperties: false },
				run: async (_s, params) => {
					const only = params.plugin !== undefined ? access.plugin(params.plugin).id : undefined;
					const screens = this.screens()
						.filter((s) => only === undefined || s.plugin === only)
						.map((s) => ({ ...s, view: this.viewSchema(s.plugin, `screen:${s.screen}`) }));
					return {
						text: screens.length
							? screens.map((s) => `- ${s.pluginName} › ${s.title}: plugin "${s.plugin}", screen "${s.screen}"${s.default ? " (default)" : ""}${s.state !== "running" ? ` (unavailable: ${s.pluginName} is ${s.state})` : ""}${s.view ? schemaText(s.view) : ""}`).join("\n")
							: "No screens are available to agents.",
						data: { screens },
					};
				},
			},
			{
				name: "read_screen",
				title: "Read a screen",
				description:
					"Read one plugin screen: tables with one line per row (pass details: true for each row's inspector details), lists, forms, stats and logs, with times as absolute and relative. It reads your own copy of the screen as it starts (the plugin's default search, filters and sort), never changing what the person sees. Pass view to search, filter or sort it in the same call (list_screens shows each screen's view controls), or view: \"person\" to read exactly what the person's screens show now. Long tables are paged.",
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
						details: { type: "boolean", description: "Include each row's inspector details: its notes, history and drawer, and the actions it allows when fewer than the table's (default false). Narrow with table and offset or a view first on long tables." },
						view: VIEW_PARAM,
					},
					required: ["plugin"],
					additionalProperties: false,
				},
				run: async (_s, params) => {
					const r = await this.readScreen(params.plugin, params.screen, {
						view: params.view as ViewInput | undefined,
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
					const viewLine = r.view === "person"
						? `The person's view${r.viewState.length ? `, currently showing ${r.viewState.join("; ")}. Rows outside it are not listed.` : " (nothing set beyond the defaults)."}`
						: `Your view: ${r.viewSummary || "as the screen starts (default search, filters and sort)"}.`;
					const header = [`# ${r.ref.pluginName} › ${r.ref.title} (plugin "${r.ref.plugin}", screen "${r.ref.screen}")`, [age, r.watched ? "a person has it open" : ""].filter(Boolean).join("; "), viewLine].filter(Boolean).join("\n");
					const meta = { ...r.ref, rendered: r.rendered, renderedAt: r.at || null, renderedAtIso: iso(r.at), personViewing: r.watched, view: r.view, viewSummary: r.viewSummary, viewState: r.viewState };
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
								const r = await this.readScreen(s.plugin, s.screen, { maxRows: 5000, budget: Number.MAX_SAFE_INTEGER, details: true });
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
				name: "show_screen",
				title: "Show the person a screen",
				description:
					"Show the person a plugin screen on every ToolBelt screen they have open (the Mac's window and paired devices), optionally with a view: search, filters, sort and controls, as if they had set them. Use it when the person asks you to show them something. The first time, their screens ask them to allow it and for how long; the call waits up to a minute for the answer. The result says which devices show it and which don't: tell the person about the ones that don't and ask what to do. The person can Restore their previous view.",
				risk: "view",
				params: {
					type: "object",
					properties: {
						plugin: str("Plugin id."),
						screen: str("Screen id; omit for the plugin's default screen."),
						view: { ...VIEW_PARAM, description: "The view to show: the screen's defaults overlaid with these. Omit to show the screen as the person last left it." },
						open_window: { type: "boolean", description: "Open ToolBelt's window on the Mac if it's closed (only when the person asked for it, or agreed)." },
						format,
					},
					required: ["plugin"],
					additionalProperties: false,
				},
				run: async (session, params) => this.show(session, params),
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
			grants: this.grants().map((g) => ({ client: g.client, granted: g.granted, until: g.until, duration: g.duration, ...(g.session ? { session: g.session } : {}) })),
			approvals: [...this.approvals.values()].map(({ resolve: _r, session: _s, ...a }) => a),
			shown: [...this.shown.values()].map(({ previous: _p, set: _v, ...s }) => s),
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
			case "answer":
				this.approvals.get(request.id)?.resolve({ allow: request.allow === true, duration: request.duration });
				return this.state();
			case "revokeGrant": {
				this.o.save({ ...settings, grants: settings.grants.filter((g) => g.client !== request.client) });
				for (const [id, g] of this.sessionGrants) if (g.client === request.client) this.sessionGrants.delete(id);
				this.emit();
				return this.state();
			}
			case "restoreView": {
				const key = `${request.plugin}\n${request.surface}`;
				const shown = this.shown.get(key);
				if (shown) {
					this.shown.delete(key);
					this.o.person?.setView(request.plugin, request.surface, shown.previous);
				}
				this.emit();
				return this.state();
			}
			case "dismissShown":
				this.shown.delete(`${request.plugin}\n${request.surface}`);
				this.emit();
				return this.state();
		}
	}

	/** Releases every surface the agent holds, and stops waiting for answers. */
	stop() {
		for (const a of [...this.approvals.values()]) a.resolve(null);
		for (const key of [...this.holds.keys()]) {
			const h = this.holds.get(key)!;
			h.pins = 0;
			this.release(key);
		}
	}
}
