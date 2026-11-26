// One isolated ToolBelt per conversation: the real plugin host and agent interface from the scenario
// harness, running the pinned OnTrack release with the seeded data, plus the generic `kit` (updates
// with secrets) and `vault` (hidden from agents) fixtures. The model reaches it the way Claude Code
// does: through the stdio shim (`toolbelt mcp`) and MCP.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpAdapter } from "../../../test/agent-scenarios/adapters";
import { createWorld, FIXTURES, type World } from "../../../test/agent-scenarios/harness";
import type { PersonAction } from "../../../test/agent-scenarios/format";
import hostPackage from "../../../package.json";
import { seedOnTrack, type Seeded } from "./seed";
import { pluginDir, setup } from "./setup";

export type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };

export type EvalWorld = {
	world: World;
	seeded: Seeded;
	/** What the MCP server said at initialize. */
	server: { name: string; version: string; protocolVersion: string; instructions: string };
	tools: McpTool[];
	/** Calls a tool; the text is what the model reads. */
	call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
	person(action: PersonAction): Promise<void>;
	/** The audit log: every call the agent made, as ToolBelt saw it. */
	audit(): { operation: string; outcome: string; plugin?: string; screen?: string; detail?: string }[];
	stop(): Promise<void>;
};

export type WorldSetup = {
	/** Per-plugin access the person chose. OnTrack 0.14 declares none, so it is hidden unless allowed. */
	access?: Record<string, "none" | "read" | "act">;
	person?: PersonAction[];
	mode?: "interactive" | "autonomous";
};

export async function openWorld(setupOpts: WorldSetup = {}, client = "agent-model-eval"): Promise<EvalWorld> {
	await setup();
	let seeded: Seeded | undefined;
	const world = await createWorld(
		{ agents: true, access: { ontrack: "read", ...setupOpts.access } },
		{
			dirs: [pluginDir("ontrack"), join(FIXTURES, "kit"), join(FIXTURES, "vault")],
			now: () => Date.now(),
			hostVersion: hostPackage.version,
			prepare: async (data) => void (seeded = await seedOnTrack(data)),
		},
	);
	try {
		for (const p of setupOpts.person ?? []) await world.person(p);
		const mcp = new McpAdapter({ socket: world.socket, autonomous: setupOpts.mode === "autonomous", client });
		const c = await mcp.connection(false);
		if (!c) throw new Error("the MCP shim could not reach the world's socket");
		const init = await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: client, version: "1" } });
		if (init.error || !init.result) throw new Error(`initialize failed: ${JSON.stringify(init.error ?? init)}`);
		c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		const list = await c.request("tools/list", {});
		const tools: McpTool[] = list.result?.tools ?? [];
		return {
			world,
			seeded: seeded!,
			server: {
				name: init.result.serverInfo?.name ?? "toolbelt",
				version: init.result.serverInfo?.version ?? "",
				protocolVersion: init.result.protocolVersion,
				instructions: init.result.instructions ?? "",
			},
			tools,
			async call(name, args) {
				const r = await c.request("tools/call", { name, arguments: args });
				if (r.closed) return { text: "ToolBelt is not reachable.", isError: true };
				if (r.error) return { text: `Error ${r.error.code}: ${r.error.message}`, isError: true };
				const text = (r.result.content ?? []).map((x: { type: string; text?: string }) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
				return { text, isError: r.result.isError === true };
			},
			person: (a) => world.person(a),
			// No file until the first call: a model that answers without tools leaves no audit log.
			audit: () => (existsSync(join(world.dir, "agent-audit.jsonl")) ? world.audit() : []),
			async stop() {
				await mcp.close();
				await world.stop();
			},
		};
	} catch (e) {
		await world.stop();
		throw e;
	}
}
