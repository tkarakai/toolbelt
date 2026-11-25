// One MCP session over the agent socket (docs/agent-interface.md): JSON-RPC 2.0, one message per line.
// Tools come from the core's operation registry; every screen is also a resource that clients
// can subscribe to. Requests are answered in order of arrival.
import type { AgentSession } from "../../shared/agents";
import { AgentRefusal, type AgentCore } from "./core";

export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
	"ToolBelt is a Mac menu bar app whose plugins show the person's tasks, software updates, processes and more. " +
	"Call toolbelt_status first, then read_screen for detail or search_screens to find something across plugins. " +
	"Access is read-only: describe what the person can do in ToolBelt rather than claiming to have done it. " +
	"Plugins kept from agents are not listed: by their author, by the person, or because they don’t declare agent access.";

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const RESOURCE = /^toolbelt:\/\/screens\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)(?:\?([^#]*))?$/;
const uriOf = (plugin: string, screen: string) => `toolbelt://screens/${plugin}/${screen}`;
/** A screen read with paging (RFC 6570 form-style query): the same parameters as read_screen. */
const TEMPLATE = "toolbelt://screens/{plugin}/{screen}{?table,parent,offset,max_rows,details}";

/** read_screen arguments from a resource URI's query; malformed values are refused. */
function pagingOf(query: string | undefined): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const [key, value] of new URLSearchParams(query ?? "")) {
		if (key === "table" || key === "parent") args[key] = value;
		else if (key === "offset" || key === "max_rows") {
			if (!/^\d+$/.test(value)) throw new RpcError(-32602, `${key} must be a whole number`);
			args[key] = Number(value);
		} else if (key === "details") {
			if (value !== "true" && value !== "false") throw new RpcError(-32602, "details must be true or false");
			args.details = value === "true";
		} else throw new RpcError(-32602, `Unknown resource parameter ${key}. Use ${TEMPLATE}.`);
	}
	return args;
}

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
			const base = surface.startsWith("screen:") ? uriOf(plugin, surface.slice(7)) : "";
			// Subscriptions to a paged URI of the screen are notified with that URI.
			for (const uri of this.subscriptions.keys()) {
				if (uri.split("?")[0] !== base || this.pendingUpdates.has(uri)) continue;
				// At most one update a second per screen.
				this.pendingUpdates.set(uri, setTimeout(() => {
					this.pendingUpdates.delete(uri);
					if (this.subscriptions.has(uri)) this.notify("notifications/resources/updated", { uri });
				}, 1000));
			}
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
					// Only for format "json", where the text is the same data serialized: clients that show
					// structuredContent instead of the text (Claude Code does) then see the same thing.
					...(r.data !== undefined && !r.isError ? { structuredContent: r.data } : {}),
					...(r.isError ? { isError: true } : {}),
				};
			}
			case "resources/list":
				// Screens of a plugin that isn't running can't be read; list_changed follows its state.
				return {
					resources: this.core.screens().filter((s) => s.state === "running").map((s) => ({
						uri: uriOf(s.plugin, s.screen),
						name: `${s.plugin}/${s.screen}`,
						title: `${s.pluginName} › ${s.title}`,
						description: `The ${s.title} screen of ${s.pluginName}, as text.`,
						mimeType: "text/markdown",
					})),
				};
			case "resources/templates/list":
				return {
					resourceTemplates: [
						{
							uriTemplate: TEMPLATE,
							name: "screen",
							title: "A ToolBelt screen, paged",
							description: "One screen as text, with read_screen's paging: table and offset for the next page of a long table, parent to page one row's child rows, max_rows, and details=false for shorter rows.",
							mimeType: "text/markdown",
						},
					],
				};
			case "resources/read": {
				const uri = String(params.uri ?? "");
				const [, plugin, screen, query] = uri.match(RESOURCE) ?? [];
				if (!plugin) throw new RpcError(-32002, `Unknown resource ${uri}`);
				const r = await this.core.call(this.session, "read_screen", { plugin, screen, ...pagingOf(query), _resource: uriOf(plugin, screen) });
				// Not found only when it doesn't exist for agents; a crashed plugin is a server-side failure.
				if (r.isError) throw new RpcError(r.kind === "refused" ? -32002 : -32603, r.text);
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
