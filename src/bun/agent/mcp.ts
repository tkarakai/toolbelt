// One MCP session over the agent socket (docs/agents.md): JSON-RPC 2.0, one message per line.
// Tools come from the core's operation registry; every screen is also a resource that clients
// can subscribe to. Requests are answered in order of arrival.
import type { AgentSession } from "../../shared/agents";
import { AgentRefusal, type AgentCore } from "./core";

export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
	"ToolBelt is a Mac menu bar app whose plugins show the person's tasks, software updates, processes and more. " +
	"Call toolbelt_status first, then read_screen for detail or search_screens to find something across plugins. " +
	"Access is read-only: describe what the person can do in ToolBelt rather than claiming to have done it. " +
	"Plugins the person or plugin author kept from agents are not listed.";

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const RESOURCE = /^toolbelt:\/\/screens\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;
const uriOf = (plugin: string, screen: string) => `toolbelt://screens/${plugin}/${screen}`;

export class McpSession {
	private subscriptions = new Map<string, () => void>();
	private pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
	private initialized = false;
	private offTree: () => void;
	private offPlugins: () => void;

	constructor(
		private readonly core: AgentCore,
		readonly session: AgentSession,
		private readonly send: (message: unknown) => void,
	) {
		this.offTree = core.onTree((plugin, surface) => {
			const uri = surface.startsWith("screen:") ? uriOf(plugin, surface.slice(7)) : "";
			if (!this.subscriptions.has(uri) || this.pendingUpdates.has(uri)) return;
			// At most one update a second per screen.
			this.pendingUpdates.set(uri, setTimeout(() => {
				this.pendingUpdates.delete(uri);
				if (this.subscriptions.has(uri)) this.notify("notifications/resources/updated", { uri });
			}, 1000));
		});
		this.offPlugins = core.onPlugins(() => {
			if (this.initialized) this.notify("notifications/resources/list_changed", {});
			// A subscription to a screen that's no longer available ends.
			for (const uri of [...this.subscriptions.keys()]) {
				const [, plugin] = uri.match(RESOURCE) ?? [];
				if (!core.visible().some((p) => p.id === plugin)) this.unsubscribe(uri);
			}
		});
	}

	close() {
		this.offTree();
		this.offPlugins();
		for (const uri of [...this.subscriptions.keys()]) this.unsubscribe(uri);
		for (const t of this.pendingUpdates.values()) clearTimeout(t);
		this.pendingUpdates.clear();
	}

	private notify(method: string, params: unknown) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private unsubscribe(uri: string) {
		this.subscriptions.get(uri)?.();
		this.subscriptions.delete(uri);
	}

	/** Handles one parsed message; replies through `send`. */
	async handle(message: Message) {
		const { id, method } = message;
		const isRequest = id !== undefined && id !== null;
		if (typeof method !== "string") {
			if (isRequest) this.send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } });
			return;
		}
		try {
			const result = await this.dispatch(method, message.params ?? {});
			if (isRequest) this.send({ jsonrpc: "2.0", id, result: result ?? {} });
		} catch (error) {
			if (!isRequest) return;
			const code = error instanceof RpcError ? error.code : error instanceof AgentRefusal ? -32602 : -32603;
			this.send({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } });
		}
	}

	private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "initialize": {
				const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
				const client = params.clientInfo as { name?: unknown } | undefined;
				if (typeof client?.name === "string") this.core.renameSession(this.session, client.name);
				return {
					protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0],
					capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true } },
					serverInfo: { name: "toolbelt", title: "ToolBelt", version: this.core.version },
					instructions: INSTRUCTIONS,
				};
			}
			case "notifications/initialized":
				this.initialized = true;
				return;
			case "ping":
				return {};
			case "tools/list":
				return {
					tools: this.core.operations.map((op) => ({
						name: op.name,
						title: op.title,
						description: op.description,
						inputSchema: op.params,
						annotations: { title: op.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
					})),
				};
			case "tools/call": {
				const name = typeof params.name === "string" ? params.name : "";
				if (!this.core.operations.some((o) => o.name === name)) throw new RpcError(-32602, `Unknown tool ${name}`);
				const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
				const r = await this.core.call(this.session, name, args);
				return {
					content: [{ type: "text", text: r.text }],
					...(r.data !== undefined && !r.isError ? { structuredContent: r.data } : {}),
					...(r.isError ? { isError: true } : {}),
				};
			}
			case "resources/list":
				return {
					resources: this.core.screens().map((s) => ({
						uri: uriOf(s.plugin, s.screen),
						name: `${s.plugin}/${s.screen}`,
						title: `${s.pluginName} › ${s.title}`,
						description: `The ${s.title} screen of ${s.pluginName}, as text.`,
						mimeType: "text/markdown",
					})),
				};
			case "resources/templates/list":
				return { resourceTemplates: [] };
			case "resources/read": {
				const uri = String(params.uri ?? "");
				const [, plugin, screen] = uri.match(RESOURCE) ?? [];
				if (!plugin) throw new RpcError(-32002, `Unknown resource ${uri}`);
				const r = await this.core.call(this.session, "read_screen", { plugin, screen });
				if (r.isError) throw new RpcError(-32002, r.text);
				return { contents: [{ uri, mimeType: "text/markdown", text: r.text }] };
			}
			case "resources/subscribe": {
				const uri = String(params.uri ?? "");
				const [, plugin, screen] = uri.match(RESOURCE) ?? [];
				if (!plugin || !this.core.screens().some((s) => s.plugin === plugin && s.screen === screen))
					throw new RpcError(-32002, `Unknown resource ${uri}`);
				if (!this.subscriptions.has(uri)) this.subscriptions.set(uri, this.core.pin(plugin, `screen:${screen}`));
				return {};
			}
			case "resources/unsubscribe":
				this.unsubscribe(String(params.uri ?? ""));
				return {};
			case "prompts/list":
				return { prompts: [] };
			default:
				if (method.startsWith("notifications/")) return;
				throw new RpcError(-32601, `Method not found: ${method}`);
		}
	}
}

class RpcError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}
