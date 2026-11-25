// The agent interface (docs/agents.md), wired for the app and the browser preview.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentSocketPath, declaredAccess, type AgentSettings, type AgentsRequest, type AgentsState } from "../../shared/agents";
import { AgentCore, type AgentCoreOptions } from "./core";
import { AgentServer } from "./server";

export type AgentInterfaceOptions = Omit<AgentCoreOptions, "auditFile" | "socket" | "command"> & {
	/** ToolBelt's folder: the socket lives here (one ToolBelt process per folder). */
	configRoot: string;
	/** The plugin profile: the audit log lives here. */
	profileRoot: string;
	/** The CLI script to show in Settings → Agents, if it exists. */
	cliScript?: string;
	/** The Bun that runs it. */
	bun: string;
};

export function createAgentInterface(o: AgentInterfaceOptions) {
	const socket = agentSocketPath(o.configRoot);
	const command = o.cliScript && existsSync(o.cliScript)
		? [o.bun, o.cliScript, "--socket", socket]
		: null;
	const core = new AgentCore({ ...o, auditFile: join(o.profileRoot, "agent-audit.jsonl"), socket, command });
	const server = new AgentServer(core, socket);
	const enable = (on: boolean) => void (on ? server.start() : server.stop());
	return {
		core,
		server,
		start: () => (o.settings().enabled ? server.start() : core.setRunning(false, null)),
		stop: () => server.stop(),
		handle: (request: AgentsRequest) => core.handle(request, enable),
	};
}

export type { AgentSettings, AgentsState };
export { declaredAccess };
