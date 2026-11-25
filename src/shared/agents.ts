// The agent interface (docs/agents.md): what AI agents may reach in ToolBelt, and what
// Settings → Agents shows about them. Shared by the main process, the renderer and the CLI.

/** How far agents may go with a plugin. `act` is reserved: agents can only read today. */
export const AGENT_ACCESS = ["none", "read", "act"] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];
const RANK: Record<AgentAccess, number> = { none: 0, read: 1, act: 2 };

/** The manifest's ceiling. A plugin that declares nothing is read-only for agents. */
export function declaredAccess(manifest: { agent?: { access?: unknown } }): AgentAccess {
	const access = manifest.agent?.access;
	return AGENT_ACCESS.includes(access as AgentAccess) ? (access as AgentAccess) : "read";
}

/** What applies: the lower of the plugin's ceiling and the person's choice. */
export function effectiveAccess(ceiling: AgentAccess, choice?: AgentAccess): AgentAccess {
	if (!choice) return ceiling;
	return RANK[choice] < RANK[ceiling] ? choice : ceiling;
}

export const atLeast = (access: AgentAccess, needed: AgentAccess) => RANK[access] >= RANK[needed];

/** Saved in settings.json under `agents`. */
export type AgentSettings = {
	/** The agent interface listens only while this is on. Off by default. */
	enabled: boolean;
	/** The person's choice per plugin id; a missing entry means the plugin's ceiling. */
	access: Record<string, AgentAccess>;
};
export const AGENT_DEFAULTS: AgentSettings = { enabled: false, access: {} };

/** Saved agent settings, each field checked; anything malformed takes its default. */
export function agentSettings(saved: unknown): AgentSettings {
	const s = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
	const access: Record<string, AgentAccess> = {};
	if (s.access && typeof s.access === "object")
		for (const [id, value] of Object.entries(s.access as Record<string, unknown>))
			if (AGENT_ACCESS.includes(value as AgentAccess)) access[id] = value as AgentAccess;
	return { enabled: s.enabled === true, access };
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

export type AgentPlugin = {
	id: string;
	name: string;
	icon: string;
	/** What the plugin allows (manifest `agent.access`, or `read`). */
	ceiling: AgentAccess;
	/** What the person chose, if anything. */
	choice?: AgentAccess;
	effective: AgentAccess;
	declared: boolean;
};

export type AgentsState = {
	enabled: boolean;
	/** Whether the socket listens, and why not. */
	running: boolean;
	error: string | null;
	socket: string;
	/** How to connect: the shim and CLI as argv (bundled Bun + script), null when not available. */
	command: string[] | null;
	plugins: AgentPlugin[];
	sessions: AgentSession[];
	/** The newest audit entries, newest first. */
	audit: AuditEntry[];
};

export type AgentsRequest =
	| { operation: "read" }
	| { operation: "setEnabled"; enabled: boolean }
	| { operation: "setAccess"; plugin: string; access: AgentAccess | null }
	| { operation: "audit"; before?: number; limit?: number };

/** The socket's first line from a client, before MCP JSON-RPC. */
export type AgentHello = { toolbelt: 1; client?: string; mode?: AgentMode };

/** Where the socket lives: `TOOLBELT_AGENT_SOCKET`, else `agent.sock` in ToolBelt's folder. */
export const agentSocketPath = (configRoot: string, env: Record<string, string | undefined> = process.env) =>
	env.TOOLBELT_AGENT_SOCKET || `${configRoot.replace(/\/$/, "")}/agent.sock`;
