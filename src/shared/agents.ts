// The agent interface (docs/agent-interface.md): what AI agents may reach in ToolBelt, and what
// Settings → Agents shows about them. Shared by the main process, the renderer and the CLI.

/** How far agents may go with a plugin. `act` is reserved: agents can only read today. */
export const AGENT_ACCESS = ["none", "read", "act"] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];
const RANK: Record<AgentAccess, number> = { none: 0, read: 1, act: 2 };

/**
 * The manifest's `agent.access`: both the default and the most the person may allow. Manifests
 * must declare it; a record without one (an installation from before protocol 2) gets `none`.
 */
export function declaredAccess(manifest: { agent?: { access?: unknown } }): AgentAccess {
	const access = manifest.agent?.access;
	return AGENT_ACCESS.includes(access as AgentAccess) ? (access as AgentAccess) : "none";
}

/** What applies: the person's choice (else what the plugin declares), never above the declaration. */
export function effectiveAccess(declared: AgentAccess, choice?: AgentAccess): AgentAccess {
	const wanted = choice ?? declared;
	return RANK[wanted] < RANK[declared] ? wanted : declared;
}

export const atLeast = (access: AgentAccess, needed: AgentAccess) => RANK[access] >= RANK[needed];

/**
 * How long the person lets an agent change what their screens show (`show_screen`). There is no
 * "forever": every grant ends.
 */
export const GRANT_DURATIONS = [
	{ id: "session", label: "This session" },
	{ id: "hour", label: "1 hour" },
	{ id: "today", label: "Today" },
	{ id: "week", label: "7 days" },
	{ id: "month", label: "30 days" },
] as const;
export type GrantDuration = (typeof GRANT_DURATIONS)[number]["id"];
export const DEFAULT_GRANT: GrantDuration = "today";

/** When a grant given at `at` for `duration` ends (epoch ms); null for "this session". */
export function grantEnd(duration: GrantDuration, at: number): number | null {
	switch (duration) {
		case "session":
			return null;
		case "hour":
			return at + 3_600_000;
		case "today": {
			const end = new Date(at);
			end.setHours(24, 0, 0, 0);
			return end.getTime();
		}
		case "week":
			return at + 7 * 86_400_000;
		case "month":
			return at + 30 * 86_400_000;
	}
}

/**
 * The person lets an agent (by client name) change what their screens show, until `until`.
 * Saved grants always end; "this session" grants live only in memory, tied to the session.
 */
export type ViewGrant = { client: string; granted: number; until: number; duration: GrantDuration };

/** Saved in settings.json under `agents`. */
export type AgentSettings = {
	/** The agent interface listens only while this is on. Off by default. */
	enabled: boolean;
	/** The person's choice per plugin id; a missing entry means what the plugin declares. */
	access: Record<string, AgentAccess>;
	/** Agents allowed to change the person's view, until each grant ends. */
	grants: ViewGrant[];
};
export const AGENT_DEFAULTS: AgentSettings = { enabled: false, access: {}, grants: [] };

/** Saved agent settings, each field checked; anything malformed takes its default. */
export function agentSettings(saved: unknown): AgentSettings {
	const s = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
	const access: Record<string, AgentAccess> = {};
	if (s.access && typeof s.access === "object")
		for (const [id, value] of Object.entries(s.access as Record<string, unknown>))
			if (AGENT_ACCESS.includes(value as AgentAccess)) access[id] = value as AgentAccess;
	const grants: ViewGrant[] = [];
	if (Array.isArray(s.grants))
		for (const g of s.grants as Record<string, unknown>[])
			if (
				g &&
				typeof g.client === "string" &&
				typeof g.granted === "number" &&
				typeof g.until === "number" &&
				GRANT_DURATIONS.some((d) => d.id === g.duration && d.id !== "session")
			)
				grants.push({ client: g.client.slice(0, 64), granted: g.granted, until: g.until, duration: g.duration as GrantDuration });
	return { enabled: s.enabled === true, access, grants };
}

/** `interactive`: a person is talking to the agent. `autonomous`: nobody is assumed present. */
export type AgentMode = "interactive" | "autonomous";

/** One connection from an agent (an MCP client through the shim, or one CLI command). */
export type AgentSession = {
	id: string;
	/** The MCP client's name ("claude-code"), or "toolbelt-cli". */
	client: string;
	mode: AgentMode;
	since: number;
};

/** One line of `agent-audit.jsonl`. Kept forever. */
export type AuditEntry = {
	at: number;
	session: string;
	client: string;
	mode: AgentMode;
	/** `connect`, `disconnect`, or the operation (`read_screen`, …). */
	operation: string;
	plugin?: string;
	screen?: string;
	outcome: "ok" | "denied" | "error";
	detail?: string;
};

/** An audit entry as read back: `id` is its position in the log, the cursor for paging. */
export type AuditRecord = AuditEntry & { id: number };

/** What the person filters Settings → Agents → Activity by. Every part given must match; a
 *  list matches any of its values. */
export type AuditFilter = {
	/** Words that must all appear in the entry: operation (or its label), plugin, screen, agent, detail. */
	query?: string;
	plugins?: string[];
	outcomes?: AuditEntry["outcome"][];
	modes?: AgentMode[];
	/** Entries at or after this time (epoch ms). */
	since?: number;
	/** Entries at or before this time (epoch ms). */
	until?: number;
};

/** A page of the audit log, newest first. `next` continues it with `before`; null at the start. */
export type AuditPage = { entries: AuditRecord[]; next: number | null };

/** How operations read to people. */
export const OPERATION_LABELS: Record<string, string> = {
	toolbelt_status: "Read status",
	list_screens: "Listed screens",
	read_screen: "Read a screen",
	search_screens: "Searched screens",
	list_plugins: "Listed plugins",
	show_screen: "Showed you a screen",
	view_grant: "Asked to change your view",
};

/** Whether an entry matches a filter. */
export function auditMatches(e: AuditEntry, f: AuditFilter = {}): boolean {
	if (f.plugins?.length && !f.plugins.includes(e.plugin ?? "")) return false;
	if (f.outcomes?.length && !f.outcomes.includes(e.outcome)) return false;
	if (f.modes?.length && !f.modes.includes(e.mode)) return false;
	if (f.since !== undefined && e.at < f.since) return false;
	if (f.until !== undefined && e.at > f.until) return false;
	const words = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const text = [e.operation, OPERATION_LABELS[e.operation], e.plugin, e.screen, e.client, e.detail].filter(Boolean).join(" ").toLowerCase();
	return words.every((w) => text.includes(w));
}

export type AgentPlugin = {
	id: string;
	name: string;
	icon: string;
	/** What the plugin declares: the default and the most the person may allow. */
	ceiling: AgentAccess;
	/** What the person chose, if anything. */
	choice?: AgentAccess;
	effective: AgentAccess;
};

/** An agent asking the person to let it change what their screens show. */
export type ViewApproval = {
	id: string;
	client: string;
	mode: AgentMode;
	/** What it wants to show: "Desk › Tasks, filtered by Status: Done". */
	what: string;
	at: number;
	/** When the agent stops waiting (epoch ms). */
	expires: number;
};

/** A screen an agent changed for the person, with how to put it back. */
export type ShownView = {
	plugin: string;
	/** The surface (`screen:<id>`). */
	surface: string;
	client: string;
	at: number;
};

export type AgentsState = {
	enabled: boolean;
	/** Whether the socket listens, and why not. */
	running: boolean;
	error: string | null;
	socket: string;
	/** How to connect: the shim and CLI as argv (bundled Bun + script), null when not available. */
	command: string[] | null;
	/** Why `command` may not keep working (it points into a development build), or null. */
	commandWarning: string | null;
	plugins: AgentPlugin[];
	sessions: AgentSession[];
	/** The newest audit entries, newest first. */
	/** The newest entries, unfiltered: Settings → Agents refreshes its activity when they change. */
	audit: AuditRecord[];
	/** Agents allowed to change the person's view, saved ones and this-session ones. */
	grants: (ViewGrant & { session?: string })[];
	/** Agents waiting for the person to answer, oldest first: every person's screen asks. */
	approvals: ViewApproval[];
	/** Screens an agent changed, each page showing "Shown by …" with Restore. */
	shown: ShownView[];
};

export type AgentsRequest =
	| { operation: "read" }
	| { operation: "setEnabled"; enabled: boolean }
	| { operation: "setAccess"; plugin: string; access: AgentAccess | null }
	/** The person's answer to a view-control request. */
	| { operation: "answer"; id: string; allow: boolean; duration?: GrantDuration }
	| { operation: "revokeGrant"; client: string }
	/** Put back the person's view from before an agent changed it, or keep it and drop the notice. */
	| { operation: "restoreView"; plugin: string; surface: string }
	| { operation: "dismissShown"; plugin: string; surface: string }
	/** A page of activity: older than the cursor `before`, or newer than `after` (an entry id). */
	| { operation: "audit"; before?: number; after?: number; limit?: number; filter?: AuditFilter };

/** The socket's first line from a client, before MCP JSON-RPC. */
/**
 * A connection's first line. `group` (at most 64 characters) groups short connections into one
 * session in the audit log: the CLI sends its parent process id, so one script's calls group.
 */
export type AgentHello = { toolbelt: 1; client?: string; mode?: AgentMode; group?: string };

/** Where the socket lives: `TOOLBELT_AGENT_SOCKET`, else `agent.sock` in ToolBelt's folder. */
export const agentSocketPath = (configRoot: string, env: Record<string, string | undefined> = process.env) =>
	env.TOOLBELT_AGENT_SOCKET || `${configRoot.replace(/\/$/, "")}/agent.sock`;
