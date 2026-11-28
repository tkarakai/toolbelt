#!/usr/bin/env bun
// `toolbelt`: ToolBelt's agent interface from a terminal (docs/agent-interface.md). `toolbelt mcp` is the
// stdio MCP server agents start; the other commands are for people, scripts and coding agents.
// Both talk to the running app over its agent socket; nothing here reads plugin data directly.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bundledSettingsFolder } from "../shared/variant";
import skill from "./SKILL.md" with { type: "text" };

const HELP = `toolbelt — read ToolBelt's plugin screens from the terminal or an AI agent.

Usage:
  toolbelt status                       App version, updates, plugins and their screens
  toolbelt screens [plugin]             Screens agents can read, with their view controls
  toolbelt read <plugin> [screen]       A screen as text (the plugin's default screen if omitted)
      --max-rows N   rows per table (default 50)
      --table ID --offset N   page through one table (offsets count top-level rows)
      --parent ROW   with --table: page that row's child rows instead
      --details      include each row's inspector details (left out by default)
      --json         the plugin's UI tree as JSON
      View: your own copy of the screen, searched, filtered and sorted (never the person's):
      --search TEXT          the screen's search
      --filter ID=A,B        check these options of a filter (ID= for all); repeatable
      --sort TABLE=KEY       sort a table by a column (-KEY descending); repeatable
      --control ID=VALUE     set a page control; repeatable
      --person               read exactly what the person's screens show instead
  toolbelt show <plugin> [screen]       Show the person a screen on every ToolBelt screen they
                                        have open, with the same view options (asks them first)
      --row ID               select this row (its {id: …} in read) with its details open
      --open-window          open ToolBelt's window on the Mac if it's closed
  toolbelt search <words…> [--plugin ID]  Lines mentioning every word, across all screens
  toolbelt plugins                      Installed plugins and available updates
  toolbelt mcp                          Run as an MCP server on stdio (for Claude Code, Codex, …)
      --client NAME  name the session in grants and the audit log (else the MCP client's own name)
  toolbelt skill                        Print the agent skill file (SKILL.md)

Options:
  --socket PATH    ToolBelt's agent socket (default: agent.sock in the folder of the app this
                   command ships in, so ToolBelt Dev's command talks to ToolBelt Dev)
  --autonomous     Mark this session as autonomous: nobody is watching it
  --json           Print the structured result as JSON (status, screens, read, search, plugins)

ToolBelt must be running with Settings → Agents → "Let agents use ToolBelt" on.
Exit codes: 1 when ToolBelt can't be reached, 2 when the call was refused or failed or the
command line is wrong.`;

/** A mistake in the command line: printed with a pointer to help, exit code 2. */
class UsageError extends Error {}
/** Flags each command takes, besides the global ones. */
const GLOBAL_FLAGS = ["socket", "autonomous", "json", "help", "h"];
const VIEW_FLAGS = ["search", "filter", "sort", "control"];
const COMMAND_FLAGS: Record<string, string[]> = {
	status: [],
	screens: ["plugin"],
	read: ["max-rows", "table", "offset", "parent", "details", "no-details", "person", ...VIEW_FLAGS],
	show: ["row", "open-window", ...VIEW_FLAGS],
	search: ["plugin"],
	plugins: [],
	mcp: ["client"],
	skill: [],
	help: [],
};

type Args = { positional: string[]; flags: Map<string, string | true>; repeated: Map<string, string[]> };
const VALUED = ["socket", "max-rows", "table", "offset", "parent", "row", "plugin", "client", ...VIEW_FLAGS];
/** Flags that may be given more than once (`--filter a=x --filter b=y`). */
const REPEATABLE = new Set(["filter", "sort", "control"]);
function parse(argv: string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	const repeated = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const at = a.indexOf("=");
			const name = at < 0 ? a.slice(2) : a.slice(2, at);
			const value = at < 0 ? (VALUED.includes(name) && i + 1 < argv.length ? argv[++i] : true) : a.slice(at + 1);
			flags.set(name, value);
			if (REPEATABLE.has(name) && typeof value === "string") repeated.set(name, [...(repeated.get(name) ?? []), value]);
		} else positional.push(a);
	}
	return { positional, flags, repeated };
}

/** read_screen/show_screen's `view` from the view flags, or undefined without any. */
function viewOf(flags: Args["flags"], repeated: Args["repeated"]) {
	const pairs = (name: string) =>
		(repeated.get(name) ?? []).map((p) => {
			const at = p.indexOf("=");
			if (at <= 0) throw new UsageError(`--${name} needs ID=VALUE (got ${p}). Run toolbelt help.`);
			return [p.slice(0, at), p.slice(at + 1)] as const;
		});
	const view: Record<string, unknown> = {};
	if (typeof flags.get("search") === "string") view.search = flags.get("search");
	const filters = pairs("filter");
	if (filters.length) view.filters = Object.fromEntries(filters.map(([id, v]) => [id, v ? v.split(",") : []]));
	const sort = pairs("sort");
	if (sort.length) view.sort = Object.fromEntries(sort);
	const controls = pairs("control");
	if (controls.length) view.controls = Object.fromEntries(controls);
	return Object.keys(view).length ? view : undefined;
}

function socketPath(flags: Args["flags"]) {
	const flag = flags.get("socket");
	if (typeof flag === "string") return flag;
	if (process.env.TOOLBELT_AGENT_SOCKET) return process.env.TOOLBELT_AGENT_SOCKET;
	if (process.env.TOOLBELT_CONFIG_DIR) return join(process.env.TOOLBELT_CONFIG_DIR, "agent.sock");
	const folder = bundledSettingsFolder(import.meta.dir, (path) => readFileSync(path, "utf8")) ?? "Toolbelt";
	return join(homedir(), "Library/Application Support", folder, "agent.sock");
}

const UNREACHABLE = (path: string) =>
	`ToolBelt isn't reachable at ${path}.\nIs ToolBelt running, with Settings → Agents → "Let agents use ToolBelt" on?`;

/** A line-based connection to the agent socket. */
async function connect(path: string, onLine: (line: string) => void, onClose: () => void) {
	const decoder = new TextDecoder();
	let buffer = "";
	return Bun.connect({
		unix: path,
		socket: {
			data(_socket, chunk) {
				buffer += decoder.decode(chunk, { stream: true });
				let i: number;
				while ((i = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, i);
					buffer = buffer.slice(i + 1);
					if (line.trim()) onLine(line);
				}
			},
			close: onClose,
			error: onClose,
		},
	});
}

const RESTARTING =
	"ToolBelt isn't reachable right now: it's restarting or quit, or agents were turned off in Settings → Agents. Try again in a few seconds; if it persists, ask the person to open ToolBelt and turn agents on.";

/**
 * `toolbelt mcp`: pipe stdio to the socket, after a hello line. When ToolBelt goes away (an
 * update, a restart, agents turned off), the shim stays up for its MCP client: it answers
 * requests with a "not reachable" error, reconnects with backoff (and right away when a request
 * arrives), replays the client's `initialize`, `initialized` and resource subscriptions on the
 * new session, and tells the client the resource list may have changed. A modern client (MCP
 * 2026-07-28) has no handshake to replay: its open `subscriptions/listen` streams are sent again
 * with their ids, their acknowledgments swallowed, and the streams told the list and their screens
 * may have changed. The streams outlive ToolBelt for the client: their graceful end when ToolBelt
 * stops isn't passed on.
 */
async function mcp(path: string, autonomous: boolean, name?: string) {
	const hello = JSON.stringify({ toolbelt: 1, client: "mcp", ...(name ? { name } : {}), mode: autonomous ? "autonomous" : "interactive" }) + "\n";
	type Conn = Awaited<ReturnType<typeof connect>>;
	let socket: Conn | null = null;
	// Read through a function: callbacks change `socket`, which narrowing can't see.
	const current = (): Conn | null => socket;
	let ended = false;
	let initialize: Record<string, unknown> | null = null;
	let initialized = false;
	const subscriptions = new Set<string>();
	/** The client's open modern streams: request id (as JSON) → the request line. */
	const listens = new Map<string, string>();
	/** Replayed streams whose acknowledgment the client already had. */
	const replayed = new Set<string>();
	// Replies to the shim's own replayed requests aren't the client's.
	const own = new Set<string>();
	let seq = 0;
	const out = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
	const fromServer = (line: string) => {
		if (own.size || listens.size)
			try {
				const m = JSON.parse(line);
				if (typeof m.id === "string" && own.delete(m.id)) return;
				// A stream's end (ToolBelt stopping) stays with the shim, which reopens it.
				if (m.id !== undefined && m.method === undefined && listens.has(JSON.stringify(m.id))) return;
				const sub = m.method === "notifications/subscriptions/acknowledged" ? m.params?._meta?.["io.modelcontextprotocol/subscriptionId"] : undefined;
				if (sub !== undefined && replayed.delete(JSON.stringify(sub))) return;
			} catch {}
		process.stdout.write(line + "\n");
	};

	async function open(): Promise<boolean> {
		let conn: Conn;
		try {
			let closed = false;
			conn = await connect(path, fromServer, () => {
				if (closed) return;
				closed = true;
				if (socket === conn) socket = null;
				if (!ended) void retry();
			});
		} catch {
			return false;
		}
		conn.write(hello);
		socket = conn;
		return true;
	}

	/** Connects again and restores the client's session on the new connection. */
	async function reopen(): Promise<boolean> {
		if (socket) return true;
		if (!(await open())) return false;
		const request = (method: string, params: unknown) => {
			const id = `toolbelt-shim-${++seq}`;
			own.add(id);
			socket!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		};
		if (initialize) request("initialize", initialize.params ?? {});
		if (initialized) socket!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
		for (const uri of subscriptions) request("resources/subscribe", { uri });
		if (initialized) out({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
		for (const [key, line] of listens) {
			replayed.add(key);
			socket!.write(line + "\n");
			const { id, params } = JSON.parse(line);
			const tag = { _meta: { "io.modelcontextprotocol/subscriptionId": id } };
			if (params?.notifications?.resourcesListChanged === true) out({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: tag });
			for (const uri of Array.isArray(params?.notifications?.resourceSubscriptions) ? params.notifications.resourceSubscriptions : [])
				out({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri, ...tag } });
		}
		return true;
	}

	let retrying = false;
	async function retry() {
		if (retrying) return;
		retrying = true;
		for (let delay = 250; !socket && !ended; delay = Math.min(delay * 2, 5000)) {
			await Bun.sleep(delay);
			if (!socket && !ended) await reopen();
		}
		retrying = false;
	}

	if (!(await open())) {
		console.error(UNREACHABLE(path));
		process.exit(1);
	}
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let i: number;
		while ((i = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (!line.trim()) continue;
			let message: { id?: unknown; method?: unknown; params?: { uri?: unknown; requestId?: unknown } } | null = null;
			try {
				message = JSON.parse(line);
			} catch {}
			// What a new connection needs to continue this client's session.
			if (message?.method === "initialize") initialize = message as Record<string, unknown>;
			if (message?.method === "notifications/initialized") initialized = true;
			if (message?.method === "resources/subscribe" && typeof message.params?.uri === "string") subscriptions.add(message.params.uri);
			if (message?.method === "resources/unsubscribe" && typeof message.params?.uri === "string") subscriptions.delete(message.params.uri);
			if (message?.method === "subscriptions/listen" && message.id !== undefined && message.id !== null) listens.set(JSON.stringify(message.id), line);
			if (message?.method === "notifications/cancelled" && message.params?.requestId !== undefined) listens.delete(JSON.stringify(message.params.requestId));
			const isRequest = message?.id !== undefined && message?.id !== null;
			if (!current() && isRequest && message?.method !== "initialize") await reopen();
			const conn = current();
			if (conn) conn.write(line + "\n");
			else if (isRequest) out({ jsonrpc: "2.0", id: message!.id, error: { code: -32000, message: RESTARTING, data: { reason: "unreachable" } } });
		}
	}
	ended = true;
	current()?.end();
}

/** One tool call over MCP, for the terminal commands. */
async function call(path: string, autonomous: boolean, tool: string, args: Record<string, unknown>) {
	const pending = new Map<number, (message: any) => void>();
	let socket: Awaited<ReturnType<typeof connect>>;
	try {
		socket = await connect(
			path,
			(line) => {
				const message = JSON.parse(line);
				if (typeof message.id === "number") pending.get(message.id)?.(message);
			},
			() => {
				for (const resolve of pending.values()) resolve({ error: { message: "ToolBelt closed the connection" } });
			},
		);
	} catch {
		console.error(UNREACHABLE(path));
		process.exit(1);
	}
	let next = 1;
	const request = (method: string, params: unknown) =>
		new Promise<any>((resolve) => {
			const id = next++;
			pending.set(id, resolve);
			socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	// One shell or script's calls (same parent process) group into one session in the audit log.
	socket.write(JSON.stringify({ toolbelt: 1, client: "toolbelt-cli", mode: autonomous ? "autonomous" : "interactive", group: `ppid:${process.ppid}` }) + "\n");
	// A modern (MCP 2026-07-28) request needs no handshake: it names its version itself.
	const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "toolbelt-cli", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
	const response = await request("tools/call", { name: tool, arguments: args, _meta: meta });
	socket.end();
	if (response.error) throw new Error(response.error.message);
	return response.result as { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean };
}

async function main() {
	const { positional, flags, repeated } = parse(process.argv.slice(2));
	const [command, ...rest] = positional;
	if (command && COMMAND_FLAGS[command]) {
		const unknown = [...flags.keys()].filter((f) => !GLOBAL_FLAGS.includes(f) && !COMMAND_FLAGS[command].includes(f));
		if (unknown.length) throw new UsageError(`Unknown option${unknown.length === 1 ? "" : "s"} for toolbelt ${command}: ${unknown.map((f) => `--${f}`).join(", ")}. Run toolbelt help.`);
		for (const name of VALUED)
			if (flags.get(name) === true) throw new UsageError(`--${name} needs a value. Run toolbelt help.`);
	}
	if (!command || command === "help" || flags.has("help") || flags.has("h")) {
		console.log(HELP);
		return;
	}
	if (command === "skill") {
		process.stdout.write(skill);
		return;
	}
	const path = socketPath(flags);
	const autonomous = flags.has("autonomous");
	if (command === "mcp") return mcp(path, autonomous, typeof flags.get("client") === "string" ? (flags.get("client") as string) : undefined);
	const int = (name: string) => {
		const v = flags.get(name);
		if (typeof v !== "string") return undefined;
		const n = Number(v);
		if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} needs a whole number`);
		return n;
	};
	const plugin = typeof flags.get("plugin") === "string" ? (flags.get("plugin") as string) : undefined;
	let tool: string;
	let args: Record<string, unknown> = {};
	switch (command) {
		case "status":
			tool = "toolbelt_status";
			break;
		case "screens":
			tool = "list_screens";
			if (rest[0] ?? plugin) args = { plugin: rest[0] ?? plugin };
			break;
		case "read":
			if (!rest[0]) throw new UsageError("Usage: toolbelt read <plugin> [screen]");
			tool = "read_screen";
			args = {
				plugin: rest[0],
				...(rest[1] ? { screen: rest[1] } : {}),
				...(int("max-rows") !== undefined ? { max_rows: int("max-rows") } : {}),
				...(typeof flags.get("table") === "string" ? { table: flags.get("table") } : {}),
				...(typeof flags.get("parent") === "string" ? { parent: flags.get("parent") } : {}),
				...(int("offset") !== undefined ? { offset: int("offset") } : {}),
				...(flags.has("details") ? { details: true } : flags.has("no-details") ? { details: false } : {}),
			};
			{
				const view = viewOf(flags, repeated);
				if (view && flags.has("person")) throw new UsageError("--person reads the person's view; it can't be combined with view options.");
				if (flags.has("person")) args.view = "person";
				else if (view) args.view = view;
			}
			break;
		case "show": {
			if (!rest[0]) throw new UsageError("Usage: toolbelt show <plugin> [screen]");
			tool = "show_screen";
			const view = viewOf(flags, repeated);
			args = { plugin: rest[0], ...(rest[1] ? { screen: rest[1] } : {}), ...(view ? { view } : {}), ...(typeof flags.get("row") === "string" ? { row: flags.get("row") } : {}), ...(flags.has("open-window") ? { open_window: true } : {}) };
			break;
		}
		case "search":
			if (!rest.length) throw new UsageError("Usage: toolbelt search <words…>");
			tool = "search_screens";
			args = { query: rest.join(" "), ...(plugin ? { plugin } : {}) };
			break;
		case "plugins":
			tool = "list_plugins";
			break;
		default:
			throw new UsageError(`Unknown command ${command}. Run toolbelt help.`);
	}
	// --json asks every tool for its structured result.
	if (flags.has("json")) args.format = "json";
	const result = await call(path, autonomous, tool, args);
	if (flags.has("json") && result.structuredContent !== undefined && !result.isError)
		console.log(JSON.stringify(result.structuredContent, null, 2));
	else console.log(result.content.map((c) => c.text).join("\n"));
	if (result.isError) process.exit(2);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(error instanceof UsageError ? 2 : 1);
});
