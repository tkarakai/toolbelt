// The agent interface (docs/agent-interface.md), wired for the app and the browser preview.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentSocketPath, declaredAccess, type AgentSettings, type AgentsRequest, type AgentsState } from "../../shared/agents";
import { AgentCore, type AgentCoreOptions } from "./core";

/**
 * Why setup commands that run `cliScript` may stop working: they point into a build or source
 * folder (a worktree's build, the browser preview) rather than an installed app.
 */
export function commandWarning(cliScript: string): string | null {
	if (/^(?:\/Users\/[^/]+)?\/Applications\/[^/]+\.app\//.test(cliScript)) return null;
	const app = cliScript.match(/^(.*?\.app)\//)?.[1];
	return `These commands run ${app ? `the ToolBelt build at ${app}` : `ToolBelt's source at ${cliScript}`}, not an installed app. Agents set up with them stop reaching ToolBelt when that ${app ? "build" : "folder"} is moved or deleted, such as when a worktree is removed. For a lasting setup, use the commands shown by ToolBelt installed in Applications.`;
}
import { AgentServer } from "./server";
import type { EventTag } from "../host";

/**
 * Where what a plugin sends while handling an event goes, by who sent the event (docs/agent-interface.md,
 * "Routing an agent's event"). An agent's navigation and clipboard text go back to the agent only
 * (the core puts them in its result); its toasts too, except those of `write`, `external` and
 * `destructive` actions, which the person also sees, as from the agent, with their buttons.
 */
export function personRouting(core: AgentCore) {
	return {
		/** Whether the person sees a toast, and as from whom (`source`: the agent's name). */
		toast: (event?: EventTag): { show: boolean; source?: string } => {
			if (event?.actor.kind !== "agent") return { show: true };
			const source = core.toastSource(event.id);
			return source ? { show: true, source } : { show: false };
		},
		/** Whether clipboard text reaches the Mac's clipboard. */
		clipboard: (event?: EventTag) => event?.actor.kind !== "agent",
		/** Whether a plugin's navigation moves the person's screens. */
		navigate: (event: EventTag) => event.actor.kind !== "agent",
	};
}

export type AgentInterfaceOptions = Omit<AgentCoreOptions, "auditFile" | "socket" | "command" | "commandWarning"> & {
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
	const core = new AgentCore({ ...o, auditFile: join(o.profileRoot, "agent-audit.jsonl"), socket, command, commandWarning: command && o.cliScript ? commandWarning(o.cliScript) : null });
	const server = new AgentServer(core, socket);
	const enable = (on: boolean) => void (on ? server.start() : server.stop());
	return {
		/** `[bun, cli, --socket, path]`: the `toolbelt` command for this ToolBelt, or null without a CLI script. */
		command,
		core,
		server,
		start: () => (o.settings().enabled ? server.start() : core.setRunning(false, null)),
		stop: () => server.stop(),
		handle: (request: AgentsRequest) => core.handle(request, enable),
		/** Where plugins' toasts, clipboard text and navigation go for agents' events. */
		routing: personRouting(core),
	};
}

export type { AgentSettings, AgentsState };
export { declaredAccess };
