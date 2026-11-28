// One MCP session over the agent socket (docs/agent-interface.md): JSON-RPC 2.0, one message per line.
// Tools come from the core's operation registry; every screen is also a resource that clients
// can subscribe to. Requests are answered in order of arrival.
//
// Dual-era (MCP 2026-07-28, Versioning): a request whose `_meta` names a protocol version is served
// statelessly per the modern revision (no handshake, `server/discover`, `resultType`, cache hints,
// `subscriptions/listen`); anything else follows the legacy `initialize` handshake revisions. One
// connection may carry both.
import type { AgentSession } from "../../shared/agents";
import { AgentRefusal, ViewRefusal, type AgentCore, type ViewInput } from "./core";

/** Legacy revisions, negotiated by `initialize`. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** Modern revisions, named in every request's `_meta`. */
export const MODERN_VERSIONS = ["2026-07-28"];
const META = "io.modelcontextprotocol/";
/** MCP 2026-07-28 error codes. */
const UNSUPPORTED_VERSION = -32022;
/** What a modern `subscriptions/listen` handler returns: its response comes when the stream ends. */
const LATER = Symbol("later");
/**
 * Cache hints (MCP 2026-07-28, Caching). Tools and templates change only with ToolBelt's version;
 * the resource list follows plugin state and access (list_changed invalidates it); a screen
 * changes any time, its updates throttled to one a second.
 */
const CACHE: Record<string, { ttlMs: number; cacheScope: "public" | "private" }> = {
	"server/discover": { ttlMs: 3_600_000, cacheScope: "private" },
	"tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
	"prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
	"resources/templates/list": { ttlMs: 3_600_000, cacheScope: "public" },
	"resources/list": { ttlMs: 5_000, cacheScope: "private" },
	"resources/read": { ttlMs: 1_000, cacheScope: "private" },
};
const INSTRUCTIONS =
	"ToolBelt is a Mac menu bar app whose plugins show the person's tasks, software updates, processes and more. " +
	"Call toolbelt_status first, then read_screen for detail or search_screens to find something across plugins. " +
	"read_screen reads your own copy of a screen; its view parameter searches, filters and sorts it in the same call without changing what the person sees. " +
	"When the person asks you to show them something, show_screen changes what their screens show, after they allow it; to show them one task or row with its details open, pass its {id: …} from read_screen as show_screen's row. " +
	"Otherwise access is read-only: describe what the person can do in ToolBelt rather than claiming to have done it. " +
	"Plugins kept from agents by their author or the person are not listed.";

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const RESOURCE = /^toolbelt:\/\/screens\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)(?:\?([^#]*))?$/;
const uriOf = (plugin: string, screen: string) => `toolbelt://screens/${plugin}/${screen}`;
/**
 * A screen read with paging and a view (RFC 6570 form-style query): read_screen's parameters.
 * View controls named by the screen go as `filter.<id>=a,b`, `sort.<table>=-key` and
 * `control.<id>=value`; `view=person` reads the person's view.
 */
const TEMPLATE = "toolbelt://screens/{plugin}/{screen}{?table,parent,offset,max_rows,details,view,search}";

/** read_screen arguments from a resource URI's query; malformed values are refused. */
function pagingOf(query: string | undefined): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	const view: { search?: string; filters?: Record<string, string[]>; sort?: Record<string, string>; controls?: Record<string, string> } = {};
	let person = false;
	for (const [key, value] of new URLSearchParams(query ?? "")) {
		const [kind, id] = key.split(/\.(.*)/s);
		if (key === "view") {
			if (value !== "person") throw new RpcError(-32602, "view must be person; give view controls as search, filter.<id>, sort.<table> and control.<id>");
			person = true;
		} else if (key === "search") view.search = value;
		else if (kind === "filter" && id) (view.filters ??= {})[id] = value ? value.split(",") : [];
		else if (kind === "sort" && id) (view.sort ??= {})[id] = value;
		else if (kind === "control" && id) (view.controls ??= {})[id] = value;
		else if (key === "table" || key === "parent") args[key] = value;
		else if (key === "offset" || key === "max_rows") {
			if (!/^\d+$/.test(value)) throw new RpcError(-32602, `${key} must be a whole number`);
			args[key] = Number(value);
		} else if (key === "details") {
			if (value !== "true" && value !== "false") throw new RpcError(-32602, "details must be true or false");
			args.details = value === "true";
		} else throw new RpcError(-32602, `Unknown resource parameter ${key}. Use ${TEMPLATE}, with filter.<id>, sort.<table> and control.<id> for view controls.`);
	}
	if (person && Object.keys(view).length) throw new RpcError(-32602, "view=person can't be combined with view controls");
	if (person) args.view = "person";
	else if (Object.keys(view).length) args.view = view;
	return args;
}

/** A resource URI without its paging: the screen and view it watches. */
function viewUri(uri: string) {
	const [base, query] = uri.split("?");
	const params = new URLSearchParams(query ?? "");
	for (const key of ["table", "parent", "offset", "max_rows", "details"]) params.delete(key);
	params.sort();
	const rest = params.toString();
	return rest ? `${base}?${rest}` : base;
}

type Era = "legacy" | "modern";
type RequestId = string | number;
/** A modern subscription stream: the screens it watches and whether it wants list changes. */
type Listen = { uris: Set<string>; list: boolean };

export class McpSession {
	/** Watched URI → the instance it watches, how to stop, and who asked for it. */
	private watches = new Map<string, { plugin: string; surface: string; instance: string; stop: () => void }>();
	/** URIs a legacy client subscribed to with `resources/subscribe`. */
	private legacy = new Set<string>();
	/** Modern `subscriptions/listen` streams, by their request id. */
	private listens = new Map<RequestId, Listen>();
	private pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();
	private initialized = false;
	/** A modern request's `clientInfo` named the session already. */
	private clientNamed = false;
	private offTree: () => void;
	private offPlugins: () => void;

	constructor(
		private readonly core: AgentCore,
		readonly session: AgentSession,
		private readonly send: (message: unknown) => void,
		/** The hello named the session: `clientInfo` doesn't rename it. */
		private readonly named = false,
	) {
		this.offTree = core.onTree((plugin, surface, instance) => {
			// Subscriptions to a paged URI of the screen's instance are notified with that URI.
			for (const [uri, w] of this.watches) {
				if (w.plugin !== plugin || w.surface !== surface || w.instance !== instance || this.pendingUpdates.has(uri)) continue;
				// At most one update a second per screen.
				this.pendingUpdates.set(uri, setTimeout(() => {
					this.pendingUpdates.delete(uri);
					if (this.legacy.has(uri)) this.notify("notifications/resources/updated", { uri });
					for (const [id, l] of this.listens) if (l.uris.has(uri)) this.notify("notifications/resources/updated", { uri }, id);
				}, 1000));
			}
		});
		this.offPlugins = core.onPlugins(() => {
			if (this.initialized) this.notify("notifications/resources/list_changed", {});
			for (const [id, l] of this.listens) if (l.list) this.notify("notifications/resources/list_changed", {}, id);
			// A subscription to a screen that's no longer available ends.
			for (const uri of [...this.watches.keys()]) {
				const [, plugin] = uri.match(RESOURCE) ?? [];
				if (core.visible().some((p) => p.id === plugin)) continue;
				this.legacy.delete(uri);
				for (const l of this.listens.values()) l.uris.delete(uri);
				this.release(uri);
			}
		});
	}

	close() {
		this.offTree();
		this.offPlugins();
		this.legacy.clear();
		this.listens.clear();
		for (const uri of [...this.watches.keys()]) this.release(uri);
		for (const t of this.pendingUpdates.values()) clearTimeout(t);
		this.pendingUpdates.clear();
	}

	/** ToolBelt stops serving agents: modern streams end gracefully (Subscriptions, Graceful Closure). */
	end() {
		for (const id of this.listens.keys()) this.send({ jsonrpc: "2.0", id, result: this.modern({ _meta: { [`${META}subscriptionId`]: id } }) });
		this.listens.clear();
	}

	/** A notification; on a modern stream it carries the stream's id. */
	private notify(method: string, params: Record<string, unknown>, subscription?: RequestId) {
		this.send({ jsonrpc: "2.0", method, params: subscription === undefined ? params : { ...params, _meta: { [`${META}subscriptionId`]: subscription } } });
	}

	/** Starts watching a screen URI (a view of it), unless something watches it already. */
	private watch(uri: string, notFound: number) {
		if (this.watches.has(uri)) return;
		const [, plugin, screen, query] = uri.match(RESOURCE) ?? [];
		if (!plugin || !this.core.screens().some((s) => s.plugin === plugin && s.screen === screen)) throw new RpcError(notFound, `Unknown resource ${uri}`);
		try {
			this.watches.set(uri, this.core.watch(plugin, screen, pagingOf(query).view as ViewInput | undefined));
		} catch (error) {
			if (error instanceof ViewRefusal) throw new RpcError(-32602, error.message);
			if (error instanceof AgentRefusal) throw new RpcError(notFound, error.message);
			throw error;
		}
	}

	/** Stops watching a URI once no legacy subscription or modern stream wants it. */
	private release(uri: string) {
		if (this.legacy.has(uri) || [...this.listens.values()].some((l) => l.uris.has(uri))) return;
		this.watches.get(uri)?.stop();
		this.watches.delete(uri);
	}

	/** A modern result: `resultType`, the server's identity and, for cacheable methods, cache hints. */
	private modern(result: Record<string, unknown>, method?: string) {
		const meta = (result._meta as Record<string, unknown> | undefined) ?? {};
		return {
			...result,
			...(method && CACHE[method] ? CACHE[method] : {}),
			resultType: "complete",
			_meta: { ...meta, [`${META}serverInfo`]: this.serverInfo() },
		};
	}

	private serverInfo() {
		return { name: "toolbelt", title: "ToolBelt", version: this.core.version };
	}

	/** Checks a modern request's `_meta` (MCP 2026-07-28, Per-request protocol fields). */
	private checkModern(meta: Record<string, unknown>) {
		const version = meta[`${META}protocolVersion`];
		// A missing required field is a malformed request; a version ToolBelt doesn't speak lists the ones it does.
		if (typeof version !== "string") throw new RpcError(-32602, `Missing ${META}protocolVersion in _meta`);
		if (!MODERN_VERSIONS.includes(version))
			throw new RpcError(UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...MCP_VERSIONS], requested: version });
		const capabilities = meta[`${META}clientCapabilities`];
		if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities))
			throw new RpcError(-32602, `Missing ${META}clientCapabilities in _meta`);
		const client = meta[`${META}clientInfo`] as { name?: unknown } | undefined;
		// The first request that names its client names the session, as initialize does for legacy clients.
		if (!this.named && !this.clientNamed && typeof client?.name === "string" && client.name.trim()) {
			this.clientNamed = true;
			this.core.renameSession(this.session, client.name);
		}
	}

	/** Handles one parsed message; replies through `send`. */
	async handle(message: Message) {
		const { id, method } = message;
		const isRequest = id !== undefined && id !== null;
		if (typeof method !== "string") {
			if (isRequest) this.send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } });
			return;
		}
		const params = message.params && typeof message.params === "object" ? message.params : {};
		const meta = params._meta && typeof params._meta === "object" ? (params._meta as Record<string, unknown>) : null;
		// Modern requests name their version; discover and listen exist only in the modern revision.
		const era: Era = (meta && `${META}protocolVersion` in meta) || method === "server/discover" || method === "subscriptions/listen" ? "modern" : "legacy";
		try {
			if (era === "modern" && isRequest) this.checkModern(meta ?? {});
			const result = await this.dispatch(method, params, era, isRequest ? id : undefined);
			if (!isRequest || result === LATER) return;
			const body = (result ?? {}) as Record<string, unknown>;
			this.send({ jsonrpc: "2.0", id, result: era === "modern" ? this.modern(body, method) : body });
		} catch (error) {
			if (!isRequest) return;
			const code = error instanceof RpcError ? error.code : error instanceof AgentRefusal ? -32602 : -32603;
			const data = error instanceof RpcError && error.data !== undefined ? { data: error.data } : {};
			this.send({ jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error), ...data } });
		}
	}

	private async dispatch(method: string, params: Record<string, unknown>, era: Era, id: RequestId | undefined): Promise<unknown> {
		// Resource not found: -32002 before 2026-07-28, Invalid Params since.
		const notFound = era === "modern" ? -32602 : -32002;
		switch (method) {
			case "initialize": {
				const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
				const client = params.clientInfo as { name?: unknown } | undefined;
				if (typeof client?.name === "string" && !this.named) this.core.renameSession(this.session, client.name);
				return {
					protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0],
					capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true } },
					serverInfo: this.serverInfo(),
					instructions: INSTRUCTIONS,
				};
			}
			case "server/discover":
				return {
					supportedVersions: [...MODERN_VERSIONS, ...MCP_VERSIONS],
					capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true } },
					instructions: INSTRUCTIONS,
				};
			case "notifications/initialized":
				this.initialized = true;
				return;
			case "ping":
				// Removed in 2026-07-28.
				if (era === "modern") throw new RpcError(-32601, "Method not found: ping");
				return {};
			case "tools/list":
				return {
					tools: this.core.operations.map((op) => ({
						name: op.name,
						title: op.title,
						description: op.description,
						inputSchema: op.params,
						// show_screen changes only what the person's screens show: not read-only, never destructive.
						annotations: { title: op.title, readOnlyHint: op.risk === "read", destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
							description: "One screen as text, with read_screen's paging and view: table and offset for the next page of a long table, parent to page one row's child rows, max_rows, details=true for rows' inspector details; search, filter.<id>=a,b, sort.<table>=-key and control.<id>=value for your own view of it, or view=person for the person's.",
							mimeType: "text/markdown",
						},
					],
				};
			case "resources/read": {
				const uri = String(params.uri ?? "");
				const [, plugin, screen, query] = uri.match(RESOURCE) ?? [];
				if (!plugin) throw new RpcError(notFound, `Unknown resource ${uri}`);
				const r = await this.core.call(this.session, "read_screen", { plugin, screen, ...pagingOf(query), _resource: viewUri(uri) });
				// Not found only when it doesn't exist for agents; a crashed plugin is a server-side failure.
				if (r.isError) throw new RpcError(r.kind === "refused" ? notFound : r.kind === "invalid" ? -32602 : -32603, r.text);
				return { contents: [{ uri, mimeType: "text/markdown", text: r.text }] };
			}
			case "resources/subscribe":
			case "resources/unsubscribe": {
				// Replaced by subscriptions/listen in 2026-07-28.
				if (era === "modern") throw new RpcError(-32601, `Method not found: ${method} (use subscriptions/listen)`);
				const uri = String(params.uri ?? "");
				if (method === "resources/unsubscribe") {
					this.legacy.delete(uri);
					this.release(uri);
					return {};
				}
				this.watch(uri, notFound);
				this.legacy.add(uri);
				return {};
			}
			case "subscriptions/listen": {
				if (id === undefined) return;
				const filter = params.notifications && typeof params.notifications === "object" ? (params.notifications as Record<string, unknown>) : null;
				if (!filter) throw new RpcError(-32602, "subscriptions/listen needs notifications");
				// The acknowledgment lists what ToolBelt honors: resource list changes and screens that
				// exist for agents. The tool and prompt lists never change.
				const uris = new Set<string>();
				for (const uri of Array.isArray(filter.resourceSubscriptions) ? filter.resourceSubscriptions : []) {
					if (typeof uri !== "string") continue;
					try {
						this.watch(uri, notFound);
						uris.add(uri);
					} catch (error) {
						if (!(error instanceof RpcError)) throw error;
					}
				}
				const list = filter.resourcesListChanged === true;
				this.listens.set(id, { uris, list });
				this.notify("notifications/subscriptions/acknowledged", {
					notifications: { ...(list ? { resourcesListChanged: true } : {}), ...(Array.isArray(filter.resourceSubscriptions) ? { resourceSubscriptions: [...uris] } : {}) },
				}, id);
				return LATER;
			}
			case "notifications/cancelled": {
				// Ends a modern stream (stdio); a cancelled ordinary request has nothing to stop.
				const requestId = params.requestId as RequestId | undefined;
				const listen = requestId !== undefined ? this.listens.get(requestId) : undefined;
				if (!listen) return;
				this.listens.delete(requestId!);
				for (const uri of listen.uris) this.release(uri);
				return;
			}
			case "prompts/list":
				return { prompts: [] };
			default:
				if (method.startsWith("notifications/")) return;
				throw new RpcError(-32601, `Method not found: ${method}`);
		}
	}
}

class RpcError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) {
		super(message);
	}
}
