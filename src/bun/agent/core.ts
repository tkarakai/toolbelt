// The agent interface's core (docs/agent-interface.md): sessions, per-plugin access, the agent's own view
// of plugin surfaces, the registry of agent operations, and the audit log. Transports (the MCP
// socket, the CLI) are adapters over `call`. Agents read through shared instances of each surface
// with a view of their own. They change the person's view (`show_screen`) under a grant the person
// gives on their own screens, and in plugins at `act` they run actions and fill forms in an acting
// instance of their own, with the person approving on ToolBelt's screens wherever it matters.
import { PERSON, type Cell, type Manifest, type Node, type Row, type ViewDeclaration, type ViewState } from "../../shared/protocol";
import type { PluginInfo } from "../../shared/plugin-state";
import { cleanView } from "../../shared/views";
import type { NavigationSelection } from "../../shared/navigation";
import type { EventSettled, EventTag } from "../host";
import { checkEvent, isRefused } from "../../shared/actions";
import { LIMITS } from "../../shared/package";
import { changes, dialogValues, pickAction, pickForm, type MissingRow, type Picked, type PickedForm, type Refusal } from "./act";
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
	type ActionEffect,
	type ChangeApprovalOutcome,
	type ChangeRequest,
	type GrantDuration,
	type ShownView,
	type ViewApproval,
	type ViewGrant,
	type WriteGrant,
} from "../../shared/agents";
import { AuditLog } from "./audit";
import { labelled, NameRefusal, resolveNames, type NamedView, type ViewNames } from "./names";
import { cellText, effectNote, findRow, maskSecrets, oneLine, searchText, stem, treeJson, treeText, TEXT_BUDGET, when, type Declared, type Hidden, type SearchHit } from "./serialize";

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
		toast(plugin: string, text: string, tone?: "default" | "success" | "error", action?: { id: string; label: string }, event?: EventTag): void;
		clipboard?(plugin: string, text: string, event?: EventTag): void;
		navigate?(plugin: string, screen: string, select: string | undefined, event: EventTag): void;
		settled?(event: EventSettled): void;
		view?(plugin: string, surface: string, view: ViewState): void;
		viewRefused?(plugin: string, surface: string, instance: string, reason: string, view: ViewState): void;
	}): () => void;
	/** What a plugin declares its actions and forms do (acting needs it). */
	declarations?(plugin: string): Declared | null;
	/** Sets an open agent instance's view (an acting instance's `view`). */
	setView?(plugin: string, surface: string, instance: string, view: ViewState): void;
	/** An agent's event on one of its own instances: its id, or why the host refused it. */
	agentEvent?(plugin: string, surface: string, instance: string, name: string, payload: unknown, actor: { kind: "agent"; client: string; session: string; mode: AgentMode }, approval: "none" | "grant" | "once"): { id: string } | { refused: string };
};

/** A device that can show ToolBelt: the Mac's window, or a paired device with ToolBelt open. */
export type PersonDevice = { name: string; kind: "mac" | "device"; showing: boolean };

/** The person's screens, for `show_screen`: provided by the app, absent in tests that don't need it. */
export type PersonScreens = {
	/** The Mac (whether its window is open) and each paired device (whether it has ToolBelt open). */
	devices(): PersonDevice[];
	/** Opens the main window on the Mac. */
	openWindow(): void;
	/** Shows a plugin screen on every person's screen that is open, optionally with a row selected (and its details open). */
	navigate(plugin: string, screen: string, selection?: NavigationSelection): void;
	/** The person's current view of a surface. */
	view(plugin: string, surface: string): ViewState;
	/** Sets the person's view of a surface: applied at once where it's open, else saved for next time. */
	setView(plugin: string, surface: string, view: ViewState): void;
};

/** What an agent asks to see: the person's own view, or its own (declared defaults overlaid). */
export type ViewInput = "person" | { search?: string; filters?: Record<string, string[]>; sort?: Record<string, string | null>; controls?: Record<string, string> };

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
	/** How long `show_screen`, `run_action` and `fill_form` wait for the person to answer (ms). Default 60 s. */
	approvalMs?: number;
	/** How long an acting instance stays open after its session's last call (ms). Default 10 minutes. */
	actingHoldMs?: number;
	/** How long `run_action` and `fill_form` wait for the acting instance's next render after the plugin answers (ms). Default 2 s. */
	settleRenderMs?: number;
};

/** What a transport lets a call do while it runs: report progress, and be cancelled by the agent. */
export type CallHooks = { progress?(message: string, progress: number, total: number): void; signal?: AbortSignal };

/** Agents' changes a session may start in a minute, at most. */
export const ACTIONS_PER_MINUTE = 30;
/** Rows a bulk action may name, at most. */
export const BULK_ROWS = 200;

/** The person's answer to an approval. */
type Answer = { allow: boolean; duration?: GrantDuration; scope?: "once" | "grant" };
/** An agent's event, while its result is awaited and a minute after: what it caused. */
type SentEvent = {
	client: string;
	effect: ActionEffect;
	toasts: { text: string; tone?: string; action?: string }[];
	clipboard: string[];
	navigation: { plugin: string; screen: string; row?: string }[];
	settled: Promise<EventSettled>;
	settle(event: EventSettled): void;
};
/** What a run_action or fill_form entry in the audit log says, filled in as the call goes. */
type ActAudit = Partial<Pick<AuditEntry, "plugin" | "screen" | "action" | "form" | "rows" | "effect" | "approval" | "result" | "error" | "events">>;
/** How long the host waits for a plugin's result, in seconds. */
const NO_ANSWER_S = LIMITS.resultMs / 1000;

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
	/** `read` changes nothing; `view` changes only what the person's screens show; `act` runs plugin events. */
	risk: "read" | "view" | "act";
	/** MCP tool annotations, when they aren't a read's. */
	annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
	params: Schema;
	/** The operation writes its own audit entry (acting: one entry with what was asked and how it was allowed). */
	audits?: boolean;
	run(session: AgentSession, params: Record<string, unknown>, hooks?: CallHooks): Promise<CallResult>;
};

/** The agent asked for something it can't have or that doesn't exist: audited as `denied`. */
export class AgentRefusal extends Error {}
/** A view the screen doesn't offer (an unknown filter, option, column or control): audited as `denied`. */
export class ViewRefusal extends AgentRefusal {}
/** What the agent asked for exists but can't be read now (a crashed plugin, a failed render): audited as `error`. */
export class AgentUnavailable extends Error {}
/**
 * An action or fill that didn't run: `reason` is a fixed phrase for the audit log (never text from
 * the screen or the agent), `approval` how far the approval got.
 */
export class ActRefusal extends AgentRefusal {
	constructor(message: string, readonly reason: string, readonly approval?: ChangeApprovalOutcome) {
		super(message);
	}
}

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
const UNAVAILABLE = (id: string, close: string[] = [], available: { id: string; name: string }[] = []) =>
	new AgentRefusal(
		`No plugin "${id}" is available to agents.${close.length ? ` Did you mean ${close.map((c) => `"${c}"`).join(" or ")}?` : ""} ${
			available.length && available.length <= 10 ? `Plugins agents can read: ${available.map((p) => `${p.id} (${p.name})`).join(", ")}.` : available.length ? "Call list_screens to see what is." : "No plugin is available to agents."
		}`,
	);
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

/** Where a row or list item is in a tree: its collection as the renderer names it (`table:<id>`), a label, and whether it has details to open. */
export function locateRow(tree: unknown, id: string, now = Date.now()): { collection: string; table: string; label: string; details: boolean } | null {
	if (Array.isArray(tree)) {
		for (const v of tree) {
			const found = locateRow(v, id, now);
			if (found) return found;
		}
	} else if (tree && typeof tree === "object") {
		const o = tree as Record<string, unknown>;
		if (o.type === "table" && typeof o.id === "string" && Array.isArray(o.rows)) {
			const t = o as Extract<Node, { type: "table" }>;
			const row = findRow(t.rows, id);
			if (row) {
				const first = t.columns[0]?.key;
				// The cell's own text, without its prefix or tags: how the person would name the row.
				const plain = (c: Cell | undefined) => (c && typeof c === "object" ? (c.at !== undefined ? cellText(c, now, false) : c.text) : c === null || c === undefined ? "" : String(c)).replace(/\s+/g, " ").trim();
				const label = (first ? plain(row.cells[first]) : "") || Object.values(row.cells).map(plain).find(Boolean) || id;
				return { collection: `table:${t.id}`, table: t.id, label, details: !!(row.details?.length || row.pane) };
			}
		}
		if (o.type === "list" && typeof o.id === "string" && Array.isArray(o.items)) {
			const item = (o as Extract<Node, { type: "list" }>).items.find((i) => i.id === id);
			if (item) return { collection: `list:${o.id}`, table: o.id, label: item.title.replace(/\s+/g, " ").trim() || id, details: false };
		}
		for (const v of Object.values(o)) if (v && typeof v === "object") {
			const found = locateRow(v, id, now);
			if (found) return found;
		}
	}
	return null;
}

/** Every row and list item id in a tree, for close matches to a mistyped one. */
function rowIds(tree: unknown, ids: string[] = []): string[] {
	if (Array.isArray(tree)) for (const v of tree) rowIds(v, ids);
	else if (tree && typeof tree === "object") {
		const o = tree as Record<string, unknown>;
		const rows = (list: Row[]) => list.forEach((r) => (ids.push(r.id), r.children && rows(r.children)));
		if (o.type === "table" && Array.isArray(o.rows)) rows(o.rows as Row[]);
		else if (o.type === "list" && Array.isArray(o.items)) for (const i of o.items as { id: string }[]) ids.push(i.id);
		else for (const v of Object.values(o)) if (v && typeof v === "object") rowIds(v, ids);
	}
	return ids;
}

/** A view state as show_screen's `view` parameter: `"-due"` sorts, ids and values. */
function viewInput(state: ViewState): Exclude<ViewInput, "person"> {
	return {
		...(state.search ? { search: state.search } : {}),
		...(state.filters && Object.keys(state.filters).length ? { filters: state.filters } : {}),
		...(state.sort && Object.keys(state.sort).length ? { sort: Object.fromEntries(Object.entries(state.sort).map(([t, s]) => [t, sortText(s)])) } : {}),
		...(state.controls && Object.keys(state.controls).length ? { controls: state.controls } : {}),
	};
}

/** The `view` parameter of read_screen and show_screen. */
const VIEW_PARAM = {
	description:
		'Search, filter and sort the screen in this read, as the person would in ToolBelt (list_screens shows each screen\'s view controls): {"search": "text", "filters": {"<filter id or label>": ["<option value or label>", …]}, "sort": {"<table id>": "<column key or title>", "-<column key>" or null for unsorted}, "controls": {"<control id or label>": "<value or label>"}}. Names match ignoring case; read_screen shows ids and values in brackets where they differ from labels, and the result says how names were read. Unset parts keep the screen\'s defaults; an empty filter list means all. Or "person" for exactly what the person\'s screens show now.',
	anyOf: [
		{ type: "string", enum: ["person"] },
		{
			type: "object",
			properties: {
				search: { type: "string" },
				filters: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
				sort: { type: "object", additionalProperties: { type: ["string", "null"] } },
				controls: { type: "object", additionalProperties: { type: "string" } },
			},
			additionalProperties: false,
		},
	],
};

/** Action ids, their labels and form ids a tree uses (offered now or not). */
function usedIds(tree: unknown, out = { actions: new Set<string>(), forms: new Set<string>(), labels: new Map<string, string>() }) {
	if (Array.isArray(tree)) for (const v of tree) usedIds(v, out);
	else if (tree && typeof tree === "object") {
		const o = tree as Record<string, unknown>;
		if (o.type === "form" && typeof o.id === "string") out.forms.add(o.id);
		if (!("type" in o) && typeof o.id === "string" && typeof o.label === "string" && ("confirm" in o || "primary" in o || "inline" in o || "menu" in o || "disabled" in o || "tone" in o || "input" in o || Object.keys(o).every((k) => ["id", "label", "icon", "key", "group", "focus", "checked", "payload"].includes(k)))) {
			out.actions.add(o.id);
			if (!out.labels.has(o.id)) out.labels.set(o.id, o.label);
		}
		for (const v of Object.values(o)) if (v && typeof v === "object") usedIds(v, out);
	}
	return out;
}

/** A screen's actions and forms for agents, after its list_screens entry. */
function actionsText(actions: { id: string; label?: string; effect: ActionEffect; describe?: string }[], forms: { id: string; effect: "view" | "write" }[], rendered: boolean) {
	const parts = actions.map((a) => {
		const note = [effectNote(a.effect, false), a.describe].filter(Boolean).join(": ");
		return `${a.label ? labelled(a.label, a.id) : a.id}${note ? ` (${note})` : ""}`;
	});
	return `${parts.length ? `\n    actions${rendered ? "" : " (declared; read the screen to see which it offers)"}: ${parts.join(", ")}` : ""}${forms.length ? `\n    forms: ${forms.map((f) => `${f.id} (${f.effect === "write" ? "write" : "draft"})`).join(", ")}` : ""}`;
}

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
	private holds = new Map<string, { timer: ReturnType<typeof setTimeout> | null; pins: number; ms: number }>();
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
			// What an agent's event caused goes back to the agent (`sent`); index.ts keeps it from the person.
			toast: (_plugin, text, tone, action, event) => {
				const sent = event && this.sent.get(event.id);
				if (sent) sent.toasts.push({ text, ...(tone && tone !== "default" ? { tone } : {}), ...(action ? { action: action.label } : {}) });
			},
			clipboard: (_plugin, text, event) => {
				const sent = event && this.sent.get(event.id);
				if (sent) sent.clipboard.push(text);
			},
			navigate: (plugin, screen, select, event) => {
				const sent = this.sent.get(event.id);
				if (sent) sent.navigation.push({ plugin, screen, ...(select !== undefined ? { row: select } : {}) });
			},
			settled: (event) => this.sent.get(event.id)?.settle(event),
			viewRefused: (plugin, surface, instance, reason) => {
				for (const a of this.acting.values()) if (a.plugin === plugin && a.surface === surface && a.instance === instance) a.refused = reason;
			},
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
		if (!p) throw UNAVAILABLE(String(id), suggest(wanted, visible.map((x) => ({ id: x.id, title: x.name }))), visible);
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

	/** Keeps an instance open for `ms` after now (default: a read's hold), opening it with `view` first. */
	private hold(plugin: string, surface: string, instance: string, view: ViewState, pin = false, ms = this.o.holdMs ?? 60_000) {
		const key = this.key(plugin, surface, instance);
		let h = this.holds.get(key);
		if (!h) {
			h = { timer: null, pins: 0, ms };
			this.holds.set(key, h);
			this.o.host.open(plugin, surface, instance, instance === PERSON ? undefined : view);
		}
		if (h.timer) clearTimeout(h.timer);
		h.timer = null;
		h.ms = Math.max(h.ms, ms);
		if (pin) h.pins++;
		if (!h.pins) h.timer = setTimeout(() => this.release(key), h.ms);
	}

	private release(key: string) {
		const h = this.holds.get(key);
		if (!h || h.pins) return;
		if (h.timer) clearTimeout(h.timer);
		this.holds.delete(key);
		const [plugin, surface, instance] = key.split("\n");
		// An acting instance that closes takes its draft with it.
		for (const [k, a] of this.acting) if (a.plugin === plugin && a.surface === surface && a.instance === instance) this.acting.delete(k);
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
				if (!h.pins) h.timer = setTimeout(() => this.release(key), h.ms);
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
		const tree = this.schemaTree(plugin, surface);
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
	 * What agents may do on a screen of a plugin at `act`: the actions its latest tree uses (labels
	 * from the tree) with what each does, or every declared action until it has rendered, and the
	 * forms agents may fill. Actions declared `agent: false` are left out.
	 */
	private screenActions(plugin: string, surface: string) {
		const declared = this.o.host.declarations?.(plugin) ?? { actions: {}, forms: {} };
		const tree = this.schemaTree(plugin, surface);
		const used = tree ? usedIds(tree) : null;
		const labels = new Map<string, string>();
		if (tree) for (const [id, label] of used!.labels) labels.set(id, label);
		const actions = Object.entries(declared.actions)
			.filter(([id, d]) => d.agent !== false && (!used || used.actions.has(id)))
			.map(([id, d]) => ({ id, ...(labels.has(id) ? { label: labels.get(id)! } : {}), effect: d.effect, ...(d.describe ? { describe: d.describe } : {}) }));
		const forms = Object.entries(declared.forms)
			.filter(([id, d]) => d.agent !== false && (!used || used.forms.has(id)))
			.map(([id, d]) => ({ id, effect: d.effect }));
		return { actions, forms, rendered: !!tree };
	}

	/** The tree view controls are read from: the person's latest, else the default agent instance's. */
	private schemaTree(plugin: string, surface: string) {
		return this.o.host.snapshot(plugin, surface, PERSON)?.tree ?? this.o.host.snapshot(plugin, surface, "agent:default")?.tree ?? null;
	}

	/** What the screen's declared view controls are called, for names in an agent's view. */
	private viewNames(plugin: string, surface: string): ViewNames {
		const declared = this.o.host.declaredView(plugin, surface) ?? {};
		const tree = this.schemaTree(plugin, surface);
		const page = tree?.type === "page" ? tree : null;
		return {
			filters: Object.keys(declared.filters ?? {}).map((id) => {
				const f = page?.filters?.find((x) => x.id === id);
				return { id, label: f?.label ?? id, options: f ? f.options.map((o) => ({ value: o.value, label: o.label })) : null };
			}),
			controls: Object.keys(declared.controls ?? {}).map((id) => {
				const c = page?.controls?.find((x) => x.id === id);
				return { id, label: c?.label ?? id, options: c ? c.options.map((o) => ({ value: o.value, label: o.label })) : null };
			}),
			tables: Object.keys(declared.sort ?? {}).map((id) => {
				const t = tableNode(tree, id);
				return { id, columns: t ? t.columns.filter((c) => c.sortable).map((c) => ({ key: c.key, title: c.title || c.key })) : null };
			}),
		};
	}

	/** Renders the screen's default agent instance first when a view may name controls by label and no tree has their labels yet. */
	private async namesReady(plugin: string, surface: string, input: ViewInput | undefined) {
		if (!input || input === "person" || typeof input !== "object" || this.schemaTree(plugin, surface)) return;
		if (![input.filters, input.sort, input.controls].some((part) => part && typeof part === "object" && Object.keys(part).length)) return;
		await this.fresh(plugin, surface, "agent:default", {});
	}

	/**
	 * The instance and view state for what the agent asked: the person's instance for "person",
	 * else an agent instance for the declared defaults overlaid with the agent's choices. Refuses
	 * view controls the screen doesn't declare, listing the ones it does.
	 */
	private viewFor(plugin: string, surface: string, input: ViewInput | undefined): { instance: string; state: ViewState; notes: string[] } {
		if (input === "person") return { instance: PERSON, state: {}, notes: [] };
		const { state, notes } = this.checkedView(plugin, surface, input);
		return { instance: instanceOf(state), state, notes };
	}

	/** An agent's view input as a view state, checked against the screen's declaration. */
	viewState(plugin: string, surface: string, input: ViewInput | undefined): ViewState {
		return this.checkedView(plugin, surface, input).state;
	}

	/**
	 * An agent's view input as a view state: names resolved to ids and values (`names.ts`), then
	 * checked against the declaration. `notes` say how names were read, for the result.
	 */
	private checkedView(plugin: string, surface: string, raw: ViewInput | undefined): { state: ViewState; notes: string[] } {
		if (raw === undefined || raw === "person") return { state: {}, notes: [] };
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ViewRefusal('view must be "person" or an object with search, filters, sort and controls.');
		const names = this.viewNames(plugin, surface);
		let resolved: { view: NamedView; notes: string[] };
		try {
			resolved = resolveNames(raw as NamedView, names);
		} catch (error) {
			if (error instanceof NameRefusal) throw new ViewRefusal(error.message);
			throw error;
		}
		const input = resolved.view as Exclude<ViewInput, "person">;
		const declared = this.o.host.declaredView(plugin, surface) ?? {};
		const schema = this.viewSchema(plugin, surface);
		const has = (o: object | undefined, id: string) => !!o && Object.hasOwn(o, id);
		const list = (ids: string[]) => (ids.length ? ids.join(", ") : "none");
		const unknown = Object.keys(input).filter((k) => !["search", "filters", "sort", "controls"].includes(k));
		if (unknown.length) throw new ViewRefusal(`Unknown view field ${unknown.join(", ")}: use search, filters, sort and controls.`);
		if (input.search !== undefined && (typeof input.search !== "string" || !declared.search)) throw new ViewRefusal(declared.search ? "view.search must be text." : "This screen has no search.");
		for (const [id, values] of Object.entries(input.filters ?? {})) {
			if (!has(declared.filters, id)) throw new ViewRefusal(`This screen has no filter "${id}". Its filters: ${list(names.filters.map((f) => labelled(f.label, f.id)))}.`);
			if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) throw new ViewRefusal(`view.filters.${id} must be a list of option values${schema ? ` (${schema.filters.find((f) => f.id === id)?.options?.map((o) => o.value).join(", ") ?? "read the screen for them"})` : ""}; [] means all.`);
		}
		const sort: Record<string, { key: string; desc: boolean } | null> = {};
		for (const [table, value] of Object.entries(input.sort ?? {})) {
			if (!has(declared.sort, table)) throw new ViewRefusal(`This screen has no sortable table "${table}". Sortable tables: ${list(Object.keys(declared.sort ?? {}))}.`);
			// null returns the table to unsorted, whatever sort it starts with.
			if (value === null) {
				sort[table] = null;
				continue;
			}
			if (typeof value !== "string" || !value.replace(/^-/, "")) throw new ViewRefusal(`view.sort.${table} must be a column key, with "-" in front for descending ("-due"), or null for unsorted.`);
			sort[table] = { key: value.replace(/^-/, ""), desc: value.startsWith("-") };
		}
		for (const [id, value] of Object.entries(input.controls ?? {})) {
			if (!has(declared.controls, id)) throw new ViewRefusal(`This screen has no control "${id}". Its controls: ${list(names.controls.map((c) => labelled(c.label, c.id)))}.`);
			if (typeof value !== "string") throw new ViewRefusal(`view.controls.${id} must be one of its option values.`);
		}
		return { state: cleanView(declared, { search: input.search, filters: input.filters, sort, controls: input.controls }), notes: resolved.notes };
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
			if (s === null) continue;
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
		for (const [table, s] of Object.entries(state.sort ?? {})) parts.push(s ? `${table} sorted by ${sortText(s)}` : `${table} unsorted`);
		for (const [id, value] of Object.entries(state.controls ?? {})) parts.push(`${schema?.controls.find((c) => c.id === id)?.label ?? id}: ${value}`);
		return parts.join("; ");
	}

	/** One screen, read for an agent. Throws AgentRefusal when it isn't available, AgentUnavailable when it can't be read now. */
	async readScreen(
		pluginId: unknown,
		screenId: unknown,
		options: { format?: "text" | "json"; maxRows?: number; table?: string; offset?: number; details?: boolean; budget?: number; parent?: string; resource?: string; view?: ViewInput; acting?: AgentSession } = {},
	) {
		const { p, screen } = this.screenOf(pluginId, screenId);
		if (p.info.state !== "running")
			throw new AgentUnavailable(`${p.name} is ${p.info.state}${p.info.error ? `: ${p.info.error.split("\n")[0]}` : ""}. The person can restart it in ToolBelt.`);
		const surface = `screen:${screen.id}`;
		let instance: string, state: ViewState, names: string[];
		let snap: ReturnType<AgentHost["snapshot"]>;
		if (options.acting) {
			// The session's acting copy, dialogs and drafts included, as its last call left it.
			if (p.effective !== "act") throw new AgentRefusal(`${p.name} doesn't let agents act, so there's no acting copy to read: read it without acting.`);
			if (options.view !== undefined) throw new ViewRefusal("acting: true reads your acting copy with the view it has; pass view to run_action or fill_form to change it, or read without acting.");
			const a = await this.actingInstance(options.acting, p, screen, undefined);
			({ instance, notes: names } = a);
			state = a.view;
			snap = this.o.host.snapshot(p.id, surface, instance);
		} else {
			await this.namesReady(p.id, surface, options.view);
			({ instance, state, notes: names } = this.viewFor(p.id, surface, options.view));
			snap = await this.fresh(p.id, surface, instance, state);
		}
		const person = this.o.host.snapshot(p.id, surface, PERSON);
		// Someone besides the agent has the person's view open.
		const personViewing = (person?.viewers ?? 0) - (this.holds.has(this.key(p.id, surface, PERSON)) ? 1 : 0) > 0;
		const ref = { plugin: p.id, screen: screen.id, pluginName: p.name, title: screen.title };
		const viewOf = { view: instance === PERSON ? ("person" as const) : options.acting ? ("acting" as const) : ("agent" as const), viewSummary: instance === PERSON ? "" : this.describeView(p.id, surface, state), names, hidden: [] as Hidden[] };
		if (snap?.error) throw new AgentUnavailable(`${p.name} › ${screen.title} couldn't be shown: ${snap.error}`);
		if (!snap?.tree) return { ref, ...viewOf, tree: null, rendered: false, text: `${p.name} › ${screen.title} hasn't rendered yet. Try again in a moment.`, viewState: [] as string[], at: 0, watched: personViewing };
		if (instance !== PERSON && !options.acting) this.checkValues(snap.tree, state);
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
		// Filters the agent chose itself aren't pointed out as hiding rows: it asked for them. Actions
		// declared `agent: false` are left out; at `act`, reads say what can be done.
		const read = { ...options, table, now: this.now(), chosen: Object.keys(state.filters ?? {}), declared: this.o.host.declarations?.(p.id) ?? undefined, acting: p.effective === "act" };
		// Only the person's view has state someone set; an agent's own view is what it asked for.
		const notes = (tree: Node) => (instance === PERSON ? treeText(tree, { maxRows: 0, details: false }).viewState : []);
		if (options.format === "json") return { ref, ...viewOf, tree: treeJson(snap.tree, read), rendered: true, text: "", viewState: notes(snap.tree), at: snap.at, watched: personViewing };
		const { text, viewState, hidden } = treeText(snap.tree, read);
		return { ref, ...viewOf, hidden, tree: null, rendered: true, text, viewState: instance === PERSON ? viewState : [], at: snap.at, watched: personViewing };
	}

	// ── the person's view: grants, approvals, show and restore ─────────────
	private sessionGrants = new Map<string, ViewGrant & { session: string }>();
	private approvals = new Map<string, ViewApproval & { session: string; resolve: (answer: Answer | null | "cancelled") => void }>();
	/** Screens an agent changed: what the person's view was before, and what it was set to. */
	private shown = new Map<string, ShownView & { previous: ViewState; set: ViewState }>();

	/** Grants in force: saved ones not yet ended, and this-session ones of live sessions. */
	private grants(): (ViewGrant & { session?: string })[] {
		const now = Date.now();
		return [...this.o.settings().grants.filter((g) => g.until > now), ...[...this.sessionGrants.values()].filter((g) => this.sessionAlive(g.session))];
	}

	private granted(session: AgentSession) {
		return this.grants().some((g) => g.client === session.client && (g.session === undefined || g.session === session.id));
	}

	/**
	 * Asks every person's screen; resolves with the answer, null when nobody answered in time, or
	 * "cancelled" when the agent withdrew the call (or its session ended) while it waited. While it
	 * waits, `hooks.progress` hears about it every 5 s.
	 */
	private ask(session: AgentSession, what: string, change?: ChangeRequest, hooks?: CallHooks) {
		const id = crypto.randomUUID();
		const wait = this.o.approvalMs ?? 60_000;
		return new Promise<Answer | null | "cancelled">((resolve) => {
			const started = Date.now();
			const progress = () => hooks?.progress?.("Waiting for your approval in ToolBelt", Math.round((Date.now() - started) / 1000), Math.round(wait / 1000));
			const timer = setTimeout(() => finish(null), wait);
			const ticks = hooks?.progress ? setInterval(progress, 5000) : undefined;
			const abort = () => finish("cancelled");
			hooks?.signal?.addEventListener("abort", abort);
			const finish = (answer: Answer | null | "cancelled") => {
				clearTimeout(timer);
				clearInterval(ticks);
				hooks?.signal?.removeEventListener("abort", abort);
				if (this.approvals.delete(id)) this.emit();
				resolve(answer);
			};
			this.approvals.set(id, { id, client: session.client, mode: session.mode, what, at: Date.now(), expires: Date.now() + wait, ...(change ? { change } : {}), session: session.id, resolve: finish });
			this.emit();
			progress();
			if (hooks?.signal?.aborted) abort();
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
		const rowId = params.row;
		if (rowId !== undefined && (typeof rowId !== "string" || !rowId)) throw new AgentRefusal("row must be a row id, as read_screen shows it in {id: …}.");
		await this.namesReady(p.id, surface, input);
		const checked = input === undefined ? null : this.checkedView(p.id, surface, input);
		const state = checked?.state ?? null;
		// The view must render with options the plugin offers before it reaches the person.
		if (state) {
			const snap = await this.fresh(p.id, surface, instanceOf(state), state);
			if (snap?.tree) this.checkValues(snap.tree, state);
		}
		// The row must be on the screen as the person will see it, before anyone is asked.
		const row = typeof rowId === "string" ? await this.rowOnView(p, screen, surface, state, rowId) : null;
		const what = `${p.name} › ${screen.title}${state ? (this.describeView(p.id, surface, state) ? `, ${this.describeView(p.id, surface, state)}` : ", as it starts") : ""}${row ? `, with "${row.label}" selected` : ""}`;
		const openWindow = params.open_window === true;
		const devices = () => person.devices();
		const canAsk = () => devices().some((d) => d.showing);
		if (!this.granted(session)) {
			if (!canAsk() && openWindow) person.openWindow();
			if (!canAsk() && !openWindow)
				throw new AgentRefusal(
					`Nobody can approve this: ${this.deviceText(devices())}. Tell the person, and ask whether to open ToolBelt's window on the Mac (call show_screen again with open_window: true) or wait until they open ToolBelt.`,
				);
			const asked = await this.ask(session, what);
			const answer = asked === "cancelled" ? null : asked;
			if (!answer) {
				this.record(session, { operation: "view_grant", plugin: p.id, screen: screen.id, outcome: "denied", detail: "no answer in time" });
				throw new AgentRefusal(`The person didn't answer within ${Math.round((this.o.approvalMs ?? 60_000) / 1000)} seconds, so nothing changed. Ask them whether to try again.`);
			}
			if (!answer.allow) {
				this.record(session, { operation: "view_grant", plugin: p.id, screen: screen.id, outcome: "denied", detail: "the person said no" });
				throw new AgentRefusal("The person didn't allow changing their view. Nothing changed. Don't ask again unless they ask you to.");
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
		person.navigate(p.id, screen.id, row ? { item: row.id, collection: row.collection, ...(row.details && { details: true }) } : undefined);
		this.emit();
		const now = devices();
		const showing = now.filter((d) => d.showing);
		const missing = now.filter((d) => !d.showing);
		const lines = [
			`Showing ${what} on ${showing.length ? showing.map((d) => d.name).join(", ") : "no screen right now"}.`,
			...(checked?.notes ?? []),
			...(row
				? [
						row.details
							? `"${row.label}" is selected and scrolled into view with its details open (in the drawer beside the table, or a sheet on a phone).`
							: `"${row.label}" is selected and scrolled into view; it has no details to open.`,
					]
				: []),
			...(state ? ["The person's view stays this way until they change it; their screen offers Restore to put back what they had."] : []),
			...(missing.length
				? [`Not showing on ${missing.map((d) => `${d.name} (${d.kind === "mac" ? "window closed" : "ToolBelt not open"})`).join(", ")}. Tell the person and ask what to do${missing.some((d) => d.kind === "mac") ? "; open_window: true opens the window on the Mac" : ""}. A device shows it when it opens ToolBelt.`]
				: []),
		];
		return { text: lines.join("\n"), data: { plugin: p.id, screen: screen.id, view: state, row: row ? { id: row.id, table: row.table, label: row.label, details: row.details } : null, shown: what, showing: showing.map((d) => d.name), notShowing: missing.map((d) => ({ name: d.name, kind: d.kind })) } };
	}

	/**
	 * Finds a row on the screen as the person will see it: with the view being set, else their
	 * current one. Refuses when it isn't there, saying which part of the view hides it and the view
	 * that includes it, or that the screen has no such row.
	 */
	private async rowOnView(p: AgentPlugin & { info: PluginInfo }, screen: { id: string; title: string }, surface: string, state: ViewState | null, id: string) {
		const declared = this.o.host.declaredView(p.id, surface) ?? undefined;
		const snap = state ? await this.fresh(p.id, surface, instanceOf(state), state) : await this.fresh(p.id, surface, PERSON);
		if (snap?.error) throw new AgentUnavailable(`${p.name} › ${screen.title} couldn't be shown: ${snap.error}`);
		if (!snap?.tree) throw new AgentUnavailable(`${p.name} › ${screen.title} hasn't rendered yet, so row "${id}" can't be found. Try again in a moment.`);
		const found = locateRow(snap.tree, id, this.now());
		if (found) return { id, ...found };
		throw await this.missingRow(p, screen, surface, snap.tree, state ?? cleanView(declared, this.o.person!.view(p.id, surface)), id, {
			where: `${p.name} › ${screen.title}${state ? " with that view" : " as the person sees it"}`,
			nothing: "Nothing changed.",
			retry: "To show it, call show_screen again with",
		});
	}

	/**
	 * Why a row isn't in a tree rendered with view `base`: the search or filter that hides it (the
	 * smallest change that includes it, found by reading the screen with it cleared) and the view
	 * that shows it, or that the screen has no such row, with close ids.
	 */
	private async missingRow(
		p: AgentPlugin & { info: PluginInfo },
		screen: { id: string; title: string },
		surface: string,
		tree: Node,
		base: ViewState,
		id: string,
		words: { where: string; nothing: string; retry: string },
	): Promise<AgentRefusal> {
		const declared = this.o.host.declaredView(p.id, surface) ?? undefined;
		const treeOf = async (view: ViewState) => {
			const snap = await this.fresh(p.id, surface, instanceOf(view), view);
			if (snap?.error) throw new AgentUnavailable(`${p.name} › ${screen.title} couldn't be shown: ${snap.error}`);
			if (!snap?.tree) throw new AgentUnavailable(`${p.name} › ${screen.title} hasn't rendered yet, so row "${id}" can't be found. Try again in a moment.`);
			return snap.tree;
		};
		const page = tree.type === "page" ? tree : null;
		const search = page?.search?.query || base.search || "";
		const filters = (page?.filters ?? []).filter((f) => f.selected.length && Object.hasOwn(declared?.filters ?? {}, f.id));
		const none = (extra = "") => {
			const close = suggest(id, rowIds(tree).map((r) => ({ id: r })));
			return new ActRefusal(
				`${p.name} › ${screen.title} has no row "${id}"${extra}.${close.length ? ` Did you mean ${close.slice(0, 3).map((c) => `"${c}"`).join(" or ")}?` : ""} read_screen shows each row's id as {id: …}; search_screens finds rows on other screens. ${words.nothing}`,
				"no such row",
			);
		};
		if (!search && !filters.length) return none();
		const clear = (view: ViewState, parts: { search?: boolean; filters?: string[] }): ViewState => ({
			...view,
			...(parts.search && { search: undefined }),
			filters: { ...view.filters, ...Object.fromEntries((parts.filters ?? []).map((f) => [f, []])) },
		});
		const everything = clear(base, { search: !!search, filters: filters.map((f) => f.id) });
		if (!locateRow(await treeOf(everything), id, this.now())) return none(", even with its search and filters cleared");
		// The smallest change that includes it: one filter or the search, else all of them.
		const candidates = [...filters.map((f) => ({ filters: [f.id] })), ...(search ? [{ search: true }] : [])];
		let change: { search?: boolean; filters?: string[] } = { search: !!search, filters: filters.map((f) => f.id) };
		if (candidates.length > 1)
			for (const c of candidates.slice(0, 6))
				if (locateRow(await treeOf(clear(base, c)), id, this.now())) {
					change = c;
					break;
				}
		const hiders = [
			...(change.search ? [`the search "${search}"`] : []),
			...filters.filter((f) => change.filters?.includes(f.id)).map((f) => `filter "${f.label}" (${f.options.filter((o) => f.selected.includes(o.value)).map((o) => o.label).join(", ") || f.selected.join(", ")})`),
		];
		// A filter cleared to "all" stays written out as []: omitting it would mean the screen's default.
		const suggested = viewInput(cleanView(declared, clear(base, change)));
		return new ActRefusal(
			`Row "${id}" isn't on ${words.where}: ${hiders.join(" and ")} hide${hiders.length === 1 ? "s" : ""} it. ${words.nothing} ${words.retry} row "${id}" and view ${JSON.stringify(suggested)}${Object.keys(suggested).length ? "" : " (the screen's defaults)"}.`,
			"row hidden by the view",
		);
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

	// ── acting: private instances, approvals, write grants, events ─────────
	/** Acting instances by session, plugin and surface: the view each has, and a view the plugin refused. */
	private acting = new Map<string, { session: string; plugin: string; surface: string; instance: string; view: ViewState; refused?: string }>();
	/** Agents' events: what each caused, for its result and for routing (`toastSource`). Kept a minute after they settle. */
	private sent = new Map<string, SentEvent>();
	/** "This session" write grants, by session and plugin. */
	private sessionWriteGrants = new Map<string, WriteGrant & { session: string }>();
	/** Each session's acting calls run one at a time: a second waits behind the first's approval. */
	private actQueue = new Map<string, Promise<void>>();
	/** When each session's recent acting calls started, for `ACTIONS_PER_MINUTE`. */
	private actTimes = new Map<string, number[]>();
	private get actingMs() {
		return this.o.actingHoldMs ?? 10 * 60_000;
	}

	/** Whether a session still counts: connected, or a grouped one a later connection may continue. */
	private sessionAlive(id: string) {
		if (this.sessions.has(id)) return true;
		const now = Date.now();
		for (const g of this.recentGroups.values()) if (g.id === id && now - g.closed < GROUP_MS) return true;
		return false;
	}

	/** Resolves once the instance renders again, or after `ms`; true when it rendered. */
	private nextRender(plugin: string, surface: string, instance: string, ms = this.o.renderWaitMs ?? 4000) {
		return new Promise<boolean>((resolve) => {
			const w = { plugin, surface, instance, done: () => (this.waiters.delete(w), clearTimeout(timer), resolve(true)) };
			const timer = setTimeout(() => (this.waiters.delete(w), resolve(false)), ms);
			this.waiters.add(w);
		});
	}

	/**
	 * The session's acting instance of a screen (`agent:<session>:<screen>`), opened on first use and
	 * held for `actingHoldMs` after the session's last call. `view` replaces its view (the screen's
	 * defaults overlaid with it); "person" copies the person's current view into it. Without `view`
	 * it keeps the view it has. Returns its current tree.
	 */
	private async actingInstance(session: AgentSession, p: AgentPlugin & { info: PluginInfo }, screen: { id: string; title: string }, input: ViewInput | undefined) {
		const surface = `screen:${screen.id}`;
		const instance = `agent:${session.id}:${screen.id}`;
		const key = `${session.id}\n${p.id}\n${surface}`;
		const declared = this.o.host.declaredView(p.id, surface) ?? undefined;
		let wanted: ViewState | null = null;
		let notes: string[] = [];
		if (input === "person") wanted = cleanView(declared, this.o.person?.view(p.id, surface) ?? {});
		else if (input !== undefined) {
			await this.namesReady(p.id, surface, input);
			({ state: wanted, notes } = this.checkedView(p.id, surface, input));
		}
		let a = this.acting.get(key);
		if (!a || !this.holds.has(this.key(p.id, surface, instance))) {
			a = { session: session.id, plugin: p.id, surface, instance, view: wanted ?? {} };
			this.acting.set(key, a);
			const rendered = this.nextRender(p.id, surface, instance);
			this.hold(p.id, surface, instance, a.view, false, this.actingMs);
			await rendered;
		} else {
			this.hold(p.id, surface, instance, a.view, false, this.actingMs);
			if (wanted && JSON.stringify(wanted) !== JSON.stringify(a.view)) {
				a.refused = undefined;
				const rendered = this.nextRender(p.id, surface, instance);
				this.o.host.setView?.(p.id, surface, instance, wanted);
				await rendered;
				if (!a.refused) a.view = wanted;
			}
		}
		if (a.refused) {
			const reason = a.refused;
			a.refused = undefined;
			throw new ActRefusal(`${p.name} refused that view: ${reason}. Your acting copy keeps the view it had. Nothing was done.`, "view refused by the plugin");
		}
		const snap = this.o.host.snapshot(p.id, surface, instance);
		if (snap?.error) throw new AgentUnavailable(`${p.name} › ${screen.title} couldn't be shown: ${snap.error}`);
		if (!snap?.tree) throw new AgentUnavailable(`${p.name} › ${screen.title} hasn't rendered yet. Try again in a moment.`);
		if (wanted) this.checkValues(snap.tree, wanted);
		return { instance, surface, tree: snap.tree, view: a.view, notes };
	}

	/** Keeps the session's acting instances open for another `actingHoldMs`: each call counts. */
	private touchActing(session: AgentSession) {
		for (const a of this.acting.values()) if (a.session === session.id && this.holds.has(this.key(a.plugin, a.surface, a.instance))) this.hold(a.plugin, a.surface, a.instance, a.view, false, this.actingMs);
	}

	/** Write grants in force: saved ones not yet ended, and this-session ones of live sessions. */
	private writeGrants(): (WriteGrant & { session?: string })[] {
		const now = Date.now();
		return [...(this.o.settings().writeGrants ?? []).filter((g) => g.until > now), ...[...this.sessionWriteGrants.values()].filter((g) => this.sessionAlive(g.session))];
	}

	/** The grant that lets this agent make changes in a plugin without asking, if any. */
	private writeGrant(session: AgentSession, plugin: string) {
		return this.writeGrants().find((g) => g.client === session.client && g.plugin === plugin && (g.session === undefined || g.session === session.id));
	}

	private grantWrites(session: AgentSession, plugin: string, duration: GrantDuration) {
		const now = Date.now();
		const until = grantEnd(duration, now);
		if (until === null) {
			this.sessionWriteGrants.set(`${session.id}\n${plugin}`, { client: session.client, plugin, granted: now, until: Number.MAX_SAFE_INTEGER, duration, session: session.id });
			return;
		}
		const settings = this.o.settings();
		const kept = (settings.writeGrants ?? []).filter((g) => !(g.client === session.client && g.plugin === plugin) && g.until > now);
		this.o.save({ ...settings, writeGrants: [...kept, { client: session.client, plugin, granted: now, until, duration }] });
	}

	/** Refuses acting on a plugin below `act`, saying whose choice that is. */
	private mayAct(p: AgentPlugin & { info: PluginInfo }) {
		if (p.effective === "act") {
			if (p.info.state !== "running") throw new AgentUnavailable(`${p.name} is ${p.info.state}. The person can restart it in ToolBelt.`);
			return;
		}
		throw new ActRefusal(
			p.ceiling === "act"
				? `The person lets agents only read ${p.name} (Settings → Agents → Plugin access). Nothing was done. Tell the person what you would change, so they can do it or allow agents to act.`
				: `${p.name} lets agents read its screens but not act on them. Nothing was done. Tell the person what to do in ToolBelt instead.`,
			"plugin doesn't allow acting",
		);
	}

	/**
	 * Asks the person on every open screen to allow a change, after checking someone can answer.
	 * Autonomous sessions never ask (wave B2). Records the question as a `change_approval` entry.
	 * Resolves when allowed (with a write grant when the person chose one); throws otherwise.
	 */
	private async approveChange(session: AgentSession, p: AgentPlugin & { info: PluginInfo }, screen: { id: string; title: string }, request: ChangeRequest, op: string, openWindow: boolean, hooks: CallHooks | undefined, audit: ActAudit) {
		const words = request.kind === "run" ? `"${request.label}"` : `this change to ${request.label}`;
		if (session.mode === "autonomous")
			throw new ActRefusal(
				`${words[0].toUpperCase()}${words.slice(1)} needs the person's approval, and an autonomous session can't ask for it. Nothing was done. Approvals an autonomous agent can wait for come with a later ToolBelt (wave B2); until then an autonomous session runs only what needs no approval${request.grantable ? ` or what a grant for changes in ${p.name} covers` : ""}.`,
				"autonomous: approval needed",
				"denied",
			);
		const person = this.o.person;
		if (!person) throw new AgentUnavailable("This ToolBelt can't ask the person to approve changes.");
		const devices = () => person.devices();
		const canAsk = () => devices().some((d) => d.showing);
		if (!canAsk() && openWindow) person.openWindow();
		if (!canAsk())
			throw new ActRefusal(
				`Nobody can approve this: ${this.deviceText(devices())}. Nothing was done. Tell the person, and ask whether to open ToolBelt's window on the Mac (call ${op} again with open_window: true) or wait until they open ToolBelt.`,
				"nobody to ask",
				"denied",
			);
		const answer = await this.ask(session, `${p.name} › ${screen.title}`, request, hooks);
		const asked = (outcome: AuditEntry["outcome"], approval: ChangeApprovalOutcome, detail: string) =>
			this.record(session, { operation: "change_approval", plugin: p.id, screen: screen.id, outcome, detail, ...(audit.action ? { action: audit.action } : {}), ...(audit.form ? { form: audit.form } : {}), rows: audit.rows ?? 0, effect: request.effect, approval });
		if (answer === "cancelled") {
			asked("denied", "cancelled", "withdrawn by the agent");
			throw new ActRefusal("You withdrew the request, so nothing was done.", "cancelled", "cancelled");
		}
		if (!answer) {
			asked("denied", "timed out", "no answer in time");
			throw new ActRefusal(`The person didn't answer within ${Math.round((this.o.approvalMs ?? 60_000) / 1000)} seconds, so nothing was done. Ask them whether to try again.`, "no answer in time", "timed out");
		}
		if (!answer.allow) {
			asked("denied", "denied", "the person said no");
			throw new ActRefusal("The person didn't allow this. Nothing was done. Don't ask again unless they ask you to.", "the person said no", "denied");
		}
		if (answer.scope === "grant" && request.grantable) {
			const duration = GRANT_DURATIONS.some((d) => d.id === answer.duration) ? answer.duration! : DEFAULT_GRANT;
			this.grantWrites(session, p.id, duration);
			asked("ok", "once", `allowed, and changes in this plugin for ${GRANT_DURATIONS.find((d) => d.id === duration)!.label.toLowerCase()}`);
		} else asked("ok", "once", "allowed once");
	}

	/** Remembers an agent's event until a minute after it settles: what it caused goes into the result. */
	private track(id: string, client: string, effect: ActionEffect): SentEvent {
		let settle!: (e: EventSettled) => void;
		const settled = new Promise<EventSettled>((resolve) => (settle = resolve));
		const record: SentEvent = {
			client,
			effect,
			toasts: [],
			clipboard: [],
			navigation: [],
			settled,
			settle: (e) => {
				settle(e);
				setTimeout(() => this.sent.delete(id), 60_000);
			},
		};
		this.sent.set(id, record);
		// A bound, should results never come (the host settles every event within its wait).
		if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value!);
		return record;
	}

	/**
	 * Who a toast an agent's event caused is shown to the person as from: the agent, for `write`,
	 * `external` and `destructive` actions (Undo stays the person's); null: the result carries it
	 * only. Toasts of other events (the person's, timers) show as they are (undefined).
	 */
	toastSource(event: string): string | null {
		const sent = this.sent.get(event);
		return sent && sent.effect !== "view" ? sent.client : null;
	}

	/** Sends one agent event on its acting instance and waits for its result. */
	private async sendAgentEvent(session: AgentSession, p: AgentPlugin & { info: PluginInfo }, a: { surface: string; instance: string }, name: string, payload: unknown, effect: ActionEffect, approval: "none" | "grant" | "once") {
		if (!this.o.host.agentEvent) throw new AgentUnavailable("This ToolBelt can't send agents' events.");
		let rendered = 0;
		const off = this.onTree((plugin, surface, instance) => {
			if (plugin === p.id && surface === a.surface && instance === a.instance) rendered++;
		});
		const r = this.o.host.agentEvent(p.id, a.surface, a.instance, name, payload, { kind: "agent", client: session.client, session: session.id, mode: session.mode }, approval);
		if ("refused" in r) {
			off();
			throw new ActRefusal(`ToolBelt didn't send it: ${r.refused}. Nothing was done.`, "refused by the host");
		}
		const record = this.track(r.id, session.client, effect);
		const settled = await record.settled;
		return { id: r.id, record, settled, rendered: () => rendered, off };
	}

	/** The acting instance's tree after the plugin answered: its next render (up to `settleRenderMs`), or now when it rendered already. */
	private async afterRender(p: { id: string }, a: { surface: string; instance: string }, renderedSince: boolean) {
		const rendered = renderedSince ? (await Bun.sleep(30), true) : await this.nextRender(p.id, a.surface, a.instance, this.o.settleRenderMs ?? 2000);
		return { tree: this.o.host.snapshot(p.id, a.surface, a.instance)?.tree ?? null, rendered };
	}

	/** What an event caused, as lines of the result: the plugin's data, toasts, clipboard text and navigation. */
	private sideEffects(p: AgentPlugin & { info: PluginInfo }, sent: SentEvent[], data: unknown[]) {
		const lines: string[] = [];
		for (const d of data) if (d !== undefined) lines.push(`The plugin returned: ${maskSecrets(JSON.stringify(d))}`);
		for (const s of sent) {
			for (const t of s.toasts) lines.push(`Toast: "${oneLine(t.text)}"${t.action ? ` [${t.action}]` : ""}${s.effect !== "view" ? `: also shown to the person in ToolBelt as from ${s.client}${t.action ? `; its ${t.action} button is theirs to press` : ""}` : ""}.`);
			for (const c of s.clipboard) lines.push(`Clipboard text (returned to you, not copied to the Mac's clipboard): "${maskSecrets(oneLine(c))}"`);
			for (const n of s.navigation) {
				const title = p.info.manifest.screens.find((x) => x.id === n.screen)?.title ?? n.screen;
				lines.push(`The plugin would show ${p.name} › ${title}${n.row !== undefined ? ` with row {id: ${n.row}} selected` : ""}: the person's screens didn't move. Use show_screen to show them.`);
			}
		}
		return lines;
	}

	/** The acting instance's changes as result lines, within the text budget. */
	private changeLines(before: Node, after: { tree: Node | null; rendered: boolean }) {
		if (!after.tree) return ["Your acting copy isn't showing anything now."];
		const diff = changes(before, after.tree, this.now());
		if (!diff.lines.length) return ["Your acting copy didn't change."];
		return ["Changes in your acting copy:", ...diff.lines.map((l) => `  ${l}`), ...(diff.more ? [`  (${diff.more} more changes: read_screen with acting: true shows the screen)`] : [])];
	}

	/** The approval in words, for the result. */
	private approvalText(approval: "none" | "grant" | "once", p: { id: string; name: string }, session: AgentSession, effect: ActionEffect) {
		if (approval === "once") return "The person allowed it in ToolBelt.";
		if (approval === "grant") {
			const g = this.writeGrant(session, p.id);
			return `Allowed by the person's grant for changes in ${p.name}${g ? (g.session ? " (this session)" : ` (until ${when(g.until, Date.now())})`) : ""}.`;
		}
		return effect === "view" ? "No approval needed: it changes only your acting copy." : "No approval needed.";
	}

	/** Runs an acting call: the per-minute limit, one at a time per session, and its one audit entry. */
	private async act(session: AgentSession, op: "run_action" | "fill_form", params: Record<string, unknown>, body: (audit: ActAudit) => Promise<CallResult>): Promise<CallResult> {
		const audit: ActAudit = { plugin: typeof params.plugin === "string" ? params.plugin : undefined, screen: typeof params.screen === "string" ? params.screen : undefined };
		const record = (outcome: AuditEntry["outcome"], detail?: string) =>
			this.record(session, {
				operation: op,
				outcome,
				...(audit.plugin ? { plugin: audit.plugin.slice(0, 64) } : {}),
				...(audit.screen ? { screen: audit.screen.slice(0, 64) } : {}),
				...(detail ? { detail } : {}),
				...(audit.action ? { action: audit.action.slice(0, 64) } : {}),
				...(audit.form ? { form: audit.form.slice(0, 64) } : {}),
				...(audit.rows !== undefined ? { rows: audit.rows } : {}),
				...(audit.effect ? { effect: audit.effect } : {}),
				...(audit.approval ? { approval: audit.approval } : {}),
				...(audit.result ? { result: audit.result } : {}),
				...(audit.error ? { error: audit.error.slice(0, 300) } : {}),
				...(audit.events?.length ? { events: audit.events } : {}),
			});
		const now = Date.now();
		const times = (this.actTimes.get(session.id) ?? []).filter((t) => now - t < 60_000);
		if (times.length >= ACTIONS_PER_MINUTE) {
			record("denied", "too many changes in a minute");
			return { text: `This session has asked for ${ACTIONS_PER_MINUTE} changes in the last minute, the most ToolBelt allows. Nothing was done. Wait a minute before trying again.`, isError: true, kind: "refused" };
		}
		times.push(now);
		this.actTimes.set(session.id, times);
		const previous = this.actQueue.get(session.id) ?? Promise.resolve();
		let done!: () => void;
		const mine = new Promise<void>((resolve) => (done = resolve));
		const chain = previous.then(() => mine);
		this.actQueue.set(session.id, chain);
		await previous;
		try {
			const result = await body(audit);
			record(result.isError ? "error" : "ok", result.isError ? (audit.result === "not-handled" ? "the plugin didn't handle it" : audit.result === "no-answer" ? "no answer from the plugin" : "the plugin failed") : undefined);
			return result;
		} catch (error) {
			const kind = error instanceof ViewRefusal ? "invalid" : error instanceof AgentRefusal ? "refused" : error instanceof AgentUnavailable ? "unavailable" : "error";
			if (error instanceof ActRefusal && error.approval) audit.approval = error.approval;
			const detail = error instanceof ActRefusal ? error.reason : error instanceof ViewRefusal ? "view refused" : error instanceof AgentRefusal ? "refused" : error instanceof AgentUnavailable ? "unavailable" : "error";
			record(kind === "refused" || kind === "invalid" ? "denied" : "error", detail);
			return { text: error instanceof Error ? error.message : String(error), isError: true, kind };
		} finally {
			done();
			if (this.actQueue.get(session.id) === chain) this.actQueue.delete(session.id);
		}
	}

	/** A picked action or form, or the refusal: a missing row is explained against the acting view. */
	private async picked<T>(p: AgentPlugin & { info: PluginInfo }, screen: { id: string; title: string }, a: { surface: string; tree: Node; view: ViewState }, pick: T | Refusal | MissingRow, op: string): Promise<T> {
		if (pick && typeof pick === "object" && "missingRow" in pick)
			throw await this.missingRow(p, screen, a.surface, a.tree, a.view, pick.missingRow, { where: `${p.name} › ${screen.title} in your acting copy`, nothing: "Nothing was done.", retry: `To act on it, call ${op} again with` });
		if (pick && typeof pick === "object" && "refused" in pick) throw new ActRefusal(pick.refused, pick.reason);
		return pick as T;
	}

	/** run_action: one action in the session's acting instance, approved where it matters. */
	private async runAction(session: AgentSession, params: Record<string, unknown>, hooks: CallHooks | undefined, audit: ActAudit): Promise<CallResult> {
		const { p, screen } = this.screenOf(params.plugin, params.screen);
		audit.plugin = p.id;
		audit.screen = screen.id;
		this.mayAct(p);
		const text = (k: string) => {
			const v = params[k];
			if (v === undefined) return undefined;
			if (typeof v !== "string" || (k !== "text" && !v)) throw new ActRefusal(`${k} must be ${k === "row" ? "a row id, as read_screen shows it in {id: …}" : "text"}.`, "malformed call");
			return v;
		};
		const action = text("action");
		if (!action) throw new ActRefusal("action is required: the action's id or label, as read_screen lists them.", "malformed call");
		audit.action = action;
		const rows = params.rows;
		if (rows !== undefined && (!Array.isArray(rows) || !rows.length || !rows.every((r) => typeof r === "string" && r))) throw new ActRefusal("rows must be a list of row ids.", "malformed call");
		if (Array.isArray(rows) && rows.length > BULK_ROWS) throw new ActRefusal(`A bulk action takes at most ${BULK_ROWS} rows; split them into calls of ${BULK_ROWS} or fewer. Nothing was done.`, "too many rows");
		if (rows !== undefined && params.row !== undefined) throw new ActRefusal("Pass row for one row or rows for several, not both.", "malformed call");
		const input = { action, row: text("row"), rows: rows as string[] | undefined, table: text("table"), dialog: text("dialog"), target: text("target"), text: text("text") };
		const a = await this.actingInstance(session, p, screen, params.view as ViewInput | undefined);
		const declared = this.o.host.declarations?.(p.id) ?? { actions: {}, forms: {} };
		const picked = await this.picked<Picked>(p, screen, a, pickAction(a.tree, declared, input), "run_action");
		const name = picked.offering.name;
		const effect: ActionEffect = declared.actions[name]?.effect ?? "view";
		const confirm = picked.offering.action.confirm;
		audit.action = name;
		audit.rows = picked.rows.length;
		audit.effect = effect;
		const checked = checkEvent(a.tree, name, picked.payload, this.o.host.declaredView(p.id, a.surface) ?? undefined);
		if (isRefused(checked)) throw new ActRefusal(`That can't run here: ${checked.refused}. Nothing was done.`, "refused by the resolver");
		const dialogOf = (tree: Node) => (picked.offering.dialog !== undefined && effect !== "view" ? dialogValues(tree, picked.offering.dialog, this.now()) : null);
		const dialog = dialogOf(a.tree);
		const asksAlways = effect === "external" || effect === "destructive" || confirm !== undefined;
		let approval: "none" | "grant" | "once" = "none";
		let before = a.tree;
		if (effect !== "view") {
			if (!asksAlways && this.writeGrant(session, p.id)) approval = "grant";
			else {
				const request: ChangeRequest = {
					kind: "run",
					plugin: p.id,
					pluginName: p.name,
					screen: screen.title,
					label: picked.offering.action.label,
					effect,
					rows: picked.rows.slice(0, 5).map((r) => r.title || r.id),
					rowCount: picked.rows.length,
					...(confirm !== undefined ? { confirm } : {}),
					...(dialog ? { fields: { title: dialog.title, values: dialog.values } } : {}),
					grantable: !asksAlways,
				};
				await this.approveChange(session, p, screen, request, "run_action", params.open_window === true, hooks, audit);
				approval = "once";
				// Only what the person saw runs: resolved again against the acting copy as it is now.
				const now = this.o.host.snapshot(p.id, a.surface, a.instance)?.tree ?? null;
				const again = now ? pickAction(now, declared, input) : null;
				const changed = !now || !again || !("offering" in again)
					? "the action isn't offered there any more"
					: again.offering.name !== name
						? "it now names another action"
						: JSON.stringify(again.payload) !== JSON.stringify(picked.payload)
							? "what it acts on changed"
							: JSON.stringify(again.rows) !== JSON.stringify(picked.rows)
								? "its rows changed"
								: again.offering.action.confirm !== confirm
									? "its confirmation changed"
									: JSON.stringify(dialogOf(now)) !== JSON.stringify(dialog)
										? "the dialog's values changed"
										: null;
				if (changed) throw new ActRefusal(`The screen changed while the person was deciding (${changed}), so nothing was done. Read it again (read_screen with acting: true) and ask again if it still makes sense.`, "changed after approval", "changed");
				before = now!;
			}
		}
		audit.approval = approval;
		const sent = await this.sendAgentEvent(session, p, a, name, picked.payload, effect, approval);
		audit.events = [sent.id];
		audit.result = sent.settled.outcome;
		if (sent.settled.error && sent.settled.outcome !== "ok") audit.error = sent.settled.error;
		const after = await this.afterRender(p, a, sent.rendered() > 0);
		sent.off();
		const label = picked.offering.action.label;
		const on = picked.rows.length === 1 ? ` on "${picked.rows[0].title || picked.rows[0].id}" {id: ${picked.rows[0].id}}` : picked.rows.length > 1 ? ` on ${picked.rows.length} rows` : dialog ? ` in dialog "${dialog.title}"` : "";
		const where = `${p.name} › ${screen.title}`;
		const s = sent.settled;
		const head =
			s.outcome === "ok"
				? `Done: ran "${label}"${on} in ${where}.`
				: s.outcome === "not-handled"
					? `Not done: ${p.name} didn't handle "${label}"${on}${s.error ? ` (${s.error})` : ""}.`
					: s.outcome === "error"
						? `Failed: ${p.name} reported an error running "${label}"${on}: ${s.error ?? "no details"}.`
						: `No answer: ${p.name} didn't answer about "${label}" within ${NO_ANSWER_S} seconds; it may still act. Read the screen (read_screen with acting: true) before trying again.`;
		const names = [...a.notes, ...(picked.notes.length ? [`Names read as: ${picked.notes.join("; ")}.`] : [])];
		const lines = [head, this.approvalText(approval, p, session, effect), ...names, ...this.sideEffects(p, [sent.record], [s.data]), ...this.changeLines(before, after)];
		const diff = after.tree ? changes(before, after.tree, this.now()) : { lines: [], more: 0 };
		const at = Date.now();
		return {
			text: lines.join("\n"),
			...(s.outcome !== "ok" ? { isError: true, kind: "error" as const } : {}),
			data: {
				outcome: s.outcome === "ok" ? "done" : s.outcome,
				...(s.error ? { error: s.error } : {}),
				plugin: p.id,
				screen: screen.id,
				action: { id: name, label, effect },
				rows: picked.rows,
				approval,
				namesRead: names,
				data: s.data ?? null,
				toasts: sent.record.toasts.map((t) => ({ ...t, shownToPerson: effect !== "view" })),
				clipboard: sent.record.clipboard.map((c) => maskSecrets(c)),
				navigation: sent.record.navigation.map((n) => ({ screen: n.screen, row: n.row ?? null })),
				changes: diff,
				event: sent.id,
				at,
				atIso: new Date(at).toISOString(),
			},
		};
	}

	/** fill_form: field events in the session's acting instance, one per value, in order. */
	private async fillForm(session: AgentSession, params: Record<string, unknown>, hooks: CallHooks | undefined, audit: ActAudit): Promise<CallResult> {
		const { p, screen } = this.screenOf(params.plugin, params.screen);
		audit.plugin = p.id;
		audit.screen = screen.id;
		this.mayAct(p);
		if (typeof params.form !== "string" || !params.form) throw new ActRefusal("form is required: the form's id or title, as read_screen shows it.", "malformed call");
		audit.form = params.form;
		const values = params.values;
		if (!values || typeof values !== "object" || Array.isArray(values)) throw new ActRefusal('values must be an object: {"<field id or label>": value, …}.', "malformed call");
		if (params.row !== undefined && (typeof params.row !== "string" || !params.row)) throw new ActRefusal("row must be a row id, as read_screen shows it in {id: …}.", "malformed call");
		const input = { form: params.form, row: params.row as string | undefined, values: values as Record<string, unknown> };
		const a = await this.actingInstance(session, p, screen, params.view as ViewInput | undefined);
		const declared = this.o.host.declarations?.(p.id) ?? { actions: {}, forms: {} };
		const picked = await this.picked<PickedForm>(p, screen, a, pickForm(a.tree, declared, input, this.now()), "fill_form");
		const effect: ActionEffect = declared.forms[picked.form]?.effect === "write" ? "write" : "view";
		audit.form = picked.form;
		audit.rows = picked.row ? 1 : 0;
		audit.effect = effect;
		let approval: "none" | "grant" | "once" = "none";
		let before = a.tree;
		if (effect === "write") {
			if (this.writeGrant(session, p.id)) approval = "grant";
			else {
				const request: ChangeRequest = {
					kind: "fill",
					plugin: p.id,
					pluginName: p.name,
					screen: screen.title,
					label: picked.title,
					effect,
					rows: picked.row ? [picked.row.title || picked.row.id] : [],
					rowCount: picked.row ? 1 : 0,
					fields: { title: picked.title, values: picked.entries.map((e) => ({ label: e.label, value: e.shown })) },
					grantable: true,
				};
				await this.approveChange(session, p, screen, request, "fill_form", params.open_window === true, hooks, audit);
				approval = "once";
				const now = this.o.host.snapshot(p.id, a.surface, a.instance)?.tree ?? null;
				const again = now ? pickForm(now, declared, input, this.now()) : null;
				const same = again && "entries" in again && again.form === picked.form && JSON.stringify(again.row) === JSON.stringify(picked.row) && JSON.stringify(again.entries.map((e) => e.payload)) === JSON.stringify(picked.entries.map((e) => e.payload));
				if (!same) throw new ActRefusal("The screen changed while the person was deciding (the form or its row isn't the same), so nothing was done. Read it again (read_screen with acting: true) and ask again if it still makes sense.", "changed after approval", "changed");
				before = now!;
			}
		}
		audit.approval = approval;
		const done: { label: string; id: string; shown: string; settled: EventSettled }[] = [];
		const records: SentEvent[] = [];
		let failure: string | null = null;
		const sents: { off: () => void; rendered: () => number }[] = [];
		for (const e of picked.entries) {
			let sent: Awaited<ReturnType<AgentCore["sendAgentEvent"]>>;
			try {
				sent = await this.sendAgentEvent(session, p, a, "field", e.payload, effect, approval);
			} catch (error) {
				if (!done.length) throw error;
				failure = `${e.label} wasn't sent: ${error instanceof Error ? error.message : String(error)}`;
				break;
			}
			sents.push(sent);
			records.push(sent.record);
			done.push({ label: e.label, id: e.field.id, shown: e.shown, settled: sent.settled });
			(audit.events ??= []).push(sent.id);
			if (sent.settled.outcome !== "ok") break;
		}
		const worst = done.find((d) => d.settled.outcome !== "ok")?.settled;
		audit.result = worst?.outcome ?? (failure ? "error" : "ok");
		if (worst?.error) audit.error = worst.error;
		const after = await this.afterRender(p, a, sents.some((x) => x.rendered() > 0));
		sents.forEach((x) => x.off());
		const where = `${p.name} › ${screen.title}`;
		const set = done.filter((d) => d.settled.outcome === "ok").map((d) => `${d.label} [${d.id}] = ${JSON.stringify(d.shown)}`);
		const left = picked.entries.length - done.length;
		const head = !worst && !failure
			? `Done: set ${set.length} field${set.length === 1 ? "" : "s"} of "${picked.title}"${picked.row ? ` for "${picked.row.title || picked.row.id}" {id: ${picked.row.id}}` : ""} in ${where}: ${set.join("; ")}.`
			: [
					set.length ? `Set ${set.join("; ")}.` : "No field was set.",
					worst ? `${done.find((d) => d.settled === worst)!.label}: ${worst.outcome === "not-handled" ? `${p.name} didn't handle it` : worst.outcome === "error" ? `${p.name} reported an error: ${worst.error ?? "no details"}` : `no answer within ${NO_ANSWER_S} seconds (it may still act)`}.` : failure!,
					...(left > 0 ? [`The other ${left} field${left === 1 ? " wasn't" : "s weren't"} sent.`] : []),
				].join(" ");
		const names = [...a.notes, ...(picked.notes.length ? [`Names read as: ${picked.notes.join("; ")}.`] : [])];
		const lines = [head, effect === "view" ? "No approval needed: the form is a draft in your acting copy; its action makes the change." : this.approvalText(approval, p, session, effect), ...names, ...this.sideEffects(p, records, done.map((d) => d.settled.data)), ...this.changeLines(before, after)];
		const at = Date.now();
		return {
			text: lines.join("\n"),
			...(worst || failure ? { isError: true, kind: "error" as const } : {}),
			data: {
				outcome: worst || failure ? "partial" : "done",
				plugin: p.id,
				screen: screen.id,
				form: { id: picked.form, title: picked.title, effect },
				row: picked.row ?? null,
				fields: done.map((d) => ({ id: d.id, label: d.label, value: d.shown, outcome: d.settled.outcome, ...(d.settled.error ? { error: d.settled.error } : {}) })),
				approval,
				namesRead: names,
				changes: after.tree ? changes(before, after.tree, this.now()) : { lines: [], more: 0 },
				events: audit.events ?? [],
				at,
				atIso: new Date(at).toISOString(),
			},
		};
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
			// A grouped session (the CLI's) keeps them while a later connection may continue it.
			if (!key) {
				this.sessionGrants.delete(session.id);
				for (const k of [...this.sessionWriteGrants.keys()]) if (k.startsWith(`${session.id}\n`)) this.sessionWriteGrants.delete(k);
			}
			for (const a of [...this.approvals.values()]) if (a.session === session.id) a.resolve(a.change ? "cancelled" : null);
			this.emit();
		}
	}

	private record(session: AgentSession, entry: Omit<AuditEntry, "at" | "session" | "client" | "mode">) {
		this.audit.append({ at: Date.now(), session: session.id, client: session.client, mode: session.mode, ...entry });
	}

	/** Runs an operation for a session: the one entry point every transport uses. */
	async call(session: AgentSession, name: string, params: Record<string, unknown> = {}, hooks?: CallHooks): Promise<CallResult> {
		const op = this.operations.find((o) => o.name === name);
		const plugin = typeof params.plugin === "string" ? params.plugin : undefined;
		const screen = typeof params.screen === "string" ? params.screen : undefined;
		if (!op) {
			this.record(session, { operation: name.slice(0, 64), outcome: "denied", detail: "unknown operation" });
			return { text: `Unknown tool ${name}.`, isError: true };
		}
		if (op.audits) {
			const result = await op.run(session, params, hooks);
			this.touchActing(session);
			this.emit();
			if (result.isError) return { text: result.text, isError: true, kind: result.kind ?? "error" };
			if (params.format === "json" && result.data !== undefined) return { text: JSON.stringify(result.data), data: result.data };
			return { text: result.text };
		}
		try {
			const result = await op.run(session, params, hooks);
			this.touchActing(session);
			this.record(session, { operation: name, plugin, screen, outcome: result.isError ? "error" : "ok" });
			this.emit();
			// Text and structured data carry the same information: the text unless JSON was asked for.
			if (result.isError) return { text: result.text, isError: true, kind: result.kind ?? "error" };
			if (params.format === "json" && result.data !== undefined) return { text: JSON.stringify(result.data), data: result.data };
			return { text: result.text };
		} catch (error) {
			const kind = error instanceof ViewRefusal ? "invalid" : error instanceof AgentRefusal ? "refused" : error instanceof AgentUnavailable ? "unavailable" : "error";
			const message = error instanceof Error ? error.message : String(error);
			this.touchActing(session);
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
					"What ToolBelt is running now: the app version and any app update, and each plugin agents can read with its state, badge, screens and any update. A badge is the plugin's own attention signal (such as unread or overdue items), not a count of everything on its screens: read the screen for totals and filter counts. Start here. list_plugins is the installation view (disabled plugins, repositories, release channels).",
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
					const acting = new Set(this.visible("act").map((p) => p.id));
					const screens = this.screens()
						.filter((s) => only === undefined || s.plugin === only)
						.map((s) => ({ ...s, view: this.viewSchema(s.plugin, `screen:${s.screen}`), ...(acting.has(s.plugin) ? this.screenActions(s.plugin, `screen:${s.screen}`) : {}) }));
					return {
						text: screens.length
							? screens
									.map(
										(s) =>
											`- ${s.pluginName} › ${s.title}: plugin "${s.plugin}", screen "${s.screen}"${s.default ? " (default)" : ""}${s.state !== "running" ? ` (unavailable: ${s.pluginName} is ${s.state})` : ""}${s.view ? schemaText(s.view) : ""}${"actions" in s && s.actions ? actionsText(s.actions, s.forms!, s.rendered!) : ""}`,
									)
									.join("\n")
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
						acting: { type: "boolean", description: "Read your acting copy of the screen instead: the one run_action and fill_form act in, with the dialogs you opened and drafts you filled, and the view you gave them (only for plugins agents may act on)." },
					},
					required: ["plugin"],
					additionalProperties: false,
				},
				run: async (session, params) => {
					const r = await this.readScreen(params.plugin, params.screen, {
						acting: params.acting === true ? session : undefined,
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
						: r.view === "acting"
							? `Your acting copy (run_action and fill_form act here; the person's screens are separate): ${r.viewSummary || "as the screen starts (default search, filters and sort)"}.`
							: [`Your view: ${r.viewSummary || "as the screen starts (default search, filters and sort)"}.`, ...r.names].join("\n");
					const header = [`# ${r.ref.pluginName} › ${r.ref.title} (plugin "${r.ref.plugin}", screen "${r.ref.screen}")`, [age, r.watched ? "a person has it open" : ""].filter(Boolean).join("; "), viewLine].filter(Boolean).join("\n");
					const meta = { ...r.ref, rendered: r.rendered, renderedAt: r.at || null, renderedAtIso: iso(r.at), personViewing: r.watched, view: r.view, viewSummary: r.viewSummary, viewState: r.viewState, namesRead: r.names };
					// JSON: the tree with the same metadata. Text: the screen as text (also as `text` in the data).
					return { text: `${header}\n\n${r.text}`, data: { ...meta, tree: r.tree } };
				},
			},
			{
				name: "search_screens",
				title: "Search all screens",
				description:
					"Find lines mentioning every word of a query across all screens agents can read (tasks, updates, notes, settings). Returns matching lines with their plugin, screen and section; read_screen gives the full context. When no line has every word, it returns the closest lines, ignoring word endings. Screens are searched as they start, so rows their default filters hide (such as archived tasks) aren't searched; the result names them and how to read them.",
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
					const find = (forms: string[], need: number) => {
						for (const r of reads) if (r) for (const hit of searchText(r.text, forms, need)) hits.push({ plugin: r.ref.plugin, screen: r.ref.screen, ...hit, matched: hit.matched.slice(0, 5) });
					};
					find(words, words.length);
					// Nothing has every word: the lines with the most of them, word endings ignored.
					let closest: number | null = null;
					for (let need = words.length; !hits.length && need >= 1; need--) {
						find(words.map(stem), need);
						if (hits.length) closest = need;
					}
					if (closest !== null) hits.splice(15);
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
								...(closest !== null
									? [`No line mentions every word of "${words.join(" ")}". Closest lines (${closest === words.length ? "every word, ignoring word endings" : `${closest} of the ${words.length} words, ignoring word endings`}):`]
									: []),
								...shown.flatMap((h) => [
									`- ${names.get(`${h.plugin}/${h.screen}`)}${h.section ? ` › ${h.section}` : ""}: ${h.line}`,
									...h.matched.slice(0, 3).map((m) => `    ↳ ${m}`),
									...(h.matched.length > 3 ? [`    ↳ (${h.matched.length - 3} more matching lines; read_screen shows the row)`] : []),
								]),
								...(hits.length > shown.length ? [`(${hits.length - shown.length} more matches; narrow the query or pass plugin)`] : []),
							]
						: [searched ? `Nothing on ${plural(searched)} mentions "${words.join(" ")}".` : "No screen could be searched."];
					// Rows the screens' default filters hide weren't searched: say which, and how to read them.
					const hidden = reads.flatMap((r) => (r && r.hidden.length ? [{ plugin: r.ref.plugin, screen: r.ref.screen, filters: r.hidden }] : []));
					if (hidden.length)
						lines.push(
							`Not searched, hidden by default filters: ${hidden
								.map((h) => `${names.get(`${h.plugin}/${h.screen}`)} (${h.filters.map((f) => `${f.label}: ${f.options.slice(0, 6).map((o) => `${o.label}${o.count !== undefined ? ` ${o.count}` : ""}`).join(", ")}${f.options.length > 6 ? ", …" : ""}`).join("; ")})`)
								.join("; ")}. read_screen with view {"filters": {"<filter>": []}} includes them.`,
						);
					if (failed.length)
						lines.push(`${plural(failed.length)} couldn't be searched, so matches there are unknown:`, ...failed.map((f) => `- ${names.get(`${f.plugin}/${f.screen}`)}: ${f.reason}`));
					return {
						text: lines.join("\n"),
						data: { matches: hits.slice(0, 100), matchCount: hits.length, closest: closest === null ? null : { words: closest, of: words.length }, screensSearched: searched, hidden, failed },
					};
				},
			},
			{
				name: "show_screen",
				title: "Show the person a screen",
				description:
					"Show the person a plugin screen on every ToolBelt screen they have open (the Mac's window and paired devices), optionally with a view: search, filters, sort and controls, as if they had set them, and optionally with one row selected and its details open. Use it when the person asks you to show them something; to show them a task's (or any row's) details, pass its row id as row. If the row isn't on the screen with that view, nothing changes and the result says which search or filter hides it and the view to pass instead. The first time, their screens ask them to allow it and for how long; the call waits up to a minute for the answer. The result says which devices show it and which don't: tell the person about the ones that don't and ask what to do. The person can Restore their previous view.",
				risk: "view",
				params: {
					type: "object",
					properties: {
						plugin: str("Plugin id."),
						screen: str("Screen id; omit for the plugin's default screen."),
						view: { ...VIEW_PARAM, description: "The view to show: the screen's defaults overlaid with these. Omit to show the screen as the person last left it." },
						row: str("A row to select and scroll to, with its details open (the drawer beside the table, or a sheet on a phone): the row's id as read_screen and search_screens show it in {id: …}. It must be on the screen with the view shown."),
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
			{
				name: "run_action",
				title: "Run an action",
				description:
					"Run one action a plugin screen offers, as the person would in ToolBelt: a row's action (row, or rows for a bulk action), a toolbar or card button, or a button in a dialog you opened. Only for plugins agents may act on: read_screen lists each action with its id and what it does: (write) changes data, (external, asks) or (destructive, asks) reach outside the plugin or can't be undone. It runs in your acting copy of the screen (read it with read_screen acting: true); view replaces that copy's view, view: \"person\" copies the person's. Actions that only open or change something in your copy run at once; changes ask the person on their ToolBelt screens first, unless they allowed changes in that plugin, and the call waits up to a minute for the answer. Destructive, external and confirmed actions ask every time. Don't run changes the person didn't ask for or agree to. If no ToolBelt screen is open, it's refused: ask the person, and pass open_window: true only when they agree. A refused or unanswered approval means nothing changed: after no answer, ask whether to try again; after a refusal, don't ask again unless they ask. The result says what the plugin did, any toast, clipboard text or navigation (none of which reaches the person's screens except toasts of changes), and what changed in your copy.",
				risk: "act",
				annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
				audits: true,
				params: {
					type: "object",
					properties: {
						plugin: str("Plugin id."),
						screen: str("Screen id; omit for the plugin's default screen."),
						action: str("The action's id or label, as read_screen lists it (a label two actions share is refused with their ids)."),
						row: str("The row it acts on: the row's id as read_screen shows it in {id: …}."),
						rows: { type: "array", items: { type: "string" }, minItems: 1, maxItems: BULK_ROWS, description: `Rows for a bulk action (at most ${BULK_ROWS}).` },
						table: str("The table, when row ids repeat across tables."),
						dialog: str("The dialog the action is in, when it's offered in several places."),
						target: str("One of the action's targets, when it has them."),
						text: str("What to send with an action that takes text (an input or composer)."),
						view: { ...VIEW_PARAM, description: 'Replace your acting copy\'s view first: the screen\'s defaults overlaid with this (as read_screen\'s view), or "person" to copy the person\'s current view, to act on a row you found there. Omit to keep the view your copy has.' },
						open_window: { type: "boolean", description: "Open ToolBelt's window on the Mac to ask for approval if no ToolBelt screen is open (only when the person asked for it, or agreed)." },
						format,
					},
					required: ["plugin", "action"],
					additionalProperties: false,
				},
				run: async (session, params, hooks) => this.act(session, "run_action", params, (audit) => this.runAction(session, params, hooks, audit)),
			},
			{
				name: "fill_form",
				title: "Fill in a form",
				description:
					"Set fields of a form on a plugin screen, as the person would type or pick them in ToolBelt: a dialog's form (a draft; its action, run with run_action, makes the change) or a form that saves as it changes, such as a row's drawer (pass row). Only for plugins agents may act on: read_screen lists each fillable form with its id, each field's id and type, and the options of choice fields. Fields and options can be named by id or label. Values are checked before anything is sent. Secret and sensitive fields can't be filled. A draft never asks; a form that saves asks the person on their ToolBelt screens first, unless they allowed changes in that plugin, as run_action does. It works in your acting copy of the screen (view as in run_action). The result says what was set and what changed in your copy.",
				risk: "act",
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
				audits: true,
				params: {
					type: "object",
					properties: {
						plugin: str("Plugin id."),
						screen: str("Screen id; omit for the plugin's default screen."),
						form: str("The form's id or title, as read_screen shows it."),
						values: {
							type: "object",
							minProperties: 1,
							additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }, { type: "array" }] },
							description: 'Field id or label → value: text; an option\'s value or label; true/false (or "on"/"off") for a switch; minutes for a duration; a list (or "Key: value, Flag" text) for tags.',
						},
						row: str("The row whose drawer holds the form: its id as read_screen shows it in {id: …}."),
						view: { ...VIEW_PARAM, description: 'Replace your acting copy\'s view first, as in run_action ("person" copies the person\'s current view).' },
						open_window: { type: "boolean", description: "Open ToolBelt's window on the Mac to ask for approval if no ToolBelt screen is open (only when the person asked for it, or agreed)." },
						format,
					},
					required: ["plugin", "form", "values"],
					additionalProperties: false,
				},
				run: async (session, params, hooks) => this.act(session, "fill_form", params, (audit) => this.fillForm(session, params, hooks, audit)),
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
			writeGrants: this.writeGrants().map((g) => ({
				client: g.client,
				plugin: g.plugin,
				pluginName: this.o.host.list().find((i) => i.manifest.id === g.plugin)?.manifest.name ?? g.plugin,
				granted: g.granted,
				until: g.until,
				duration: g.duration,
				...(g.session ? { session: g.session } : {}),
			})),
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
				// Lowering access releases what the agent held of that plugin; below `act`, its acting copies and drafts go.
				const acting = new Set([...this.acting.values()].filter((a) => a.plugin === request.plugin).map((a) => this.key(a.plugin, a.surface, a.instance)));
				for (const key of [...this.holds.keys()])
					if (key.startsWith(`${request.plugin}\n`) && (!this.visible().some((p) => p.id === request.plugin) || (acting.has(key) && !this.visible("act").some((p) => p.id === request.plugin)))) {
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
				this.approvals.get(request.id)?.resolve({ allow: request.allow === true, duration: request.duration, scope: request.scope === "grant" ? "grant" : "once" });
				return this.state();
			case "revokeWriteGrant": {
				this.o.save({ ...settings, writeGrants: (settings.writeGrants ?? []).filter((g) => !(g.client === request.client && g.plugin === request.plugin)) });
				for (const [k, g] of this.sessionWriteGrants) if (g.client === request.client && g.plugin === request.plugin) this.sessionWriteGrants.delete(k);
				this.emit();
				return this.state();
			}
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
		for (const a of [...this.approvals.values()]) a.resolve(a.change ? "cancelled" : null);
		for (const key of [...this.holds.keys()]) {
			const h = this.holds.get(key)!;
			h.pins = 0;
			this.release(key);
		}
	}
}
