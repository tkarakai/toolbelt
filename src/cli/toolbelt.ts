#!/usr/bin/env bun
// `toolbelt`: ToolBelt's agent interface from a terminal (docs/agent-interface.md). `toolbelt mcp` is the
// stdio MCP server agents start; the other commands are for people, scripts and coding agents.
// Both talk to the running app over its agent socket; nothing here reads plugin data directly.
import { homedir } from "node:os";
import { join } from "node:path";
import skill from "./SKILL.md" with { type: "text" };

const HELP = `toolbelt — read ToolBelt's plugin screens from the terminal or an AI agent.

Usage:
  toolbelt status                       App version, updates, plugins and their screens
  toolbelt screens [plugin]             Screens agents can read
  toolbelt read <plugin> [screen]       A screen as text (the plugin's default screen if omitted)
      --max-rows N   rows per table (default 100)
      --table ID --offset N   page through one table
      --no-details   leave out row details
      --json         the plugin's UI tree as JSON
  toolbelt search <words…> [--plugin ID]  Lines mentioning every word, across all screens
  toolbelt plugins                      Installed plugins and available updates
  toolbelt mcp                          Run as an MCP server on stdio (for Claude Code, Codex, …)
  toolbelt skill                        Print the agent skill file (SKILL.md)

Options:
  --socket PATH    ToolBelt's agent socket (default: ToolBelt's folder/agent.sock)
  --autonomous     Mark this session as autonomous: nobody is watching it
  --json           Print the structured result as JSON (status, screens, read, search, plugins)

ToolBelt must be running with Settings → Agents → "Let agents use ToolBelt" on.`;

type Args = { positional: string[]; flags: Map<string, string | true> };
function parse(argv: string[]): Args {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	const valued = new Set(["socket", "max-rows", "table", "offset", "plugin"]);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const [name, inline] = a.slice(2).split("=", 2);
			if (inline !== undefined) flags.set(name, inline);
			else if (valued.has(name) && i + 1 < argv.length) flags.set(name, argv[++i]);
			else flags.set(name, true);
		} else positional.push(a);
	}
	return { positional, flags };
}

function socketPath(flags: Args["flags"]) {
	const flag = flags.get("socket");
	if (typeof flag === "string") return flag;
	if (process.env.TOOLBELT_AGENT_SOCKET) return process.env.TOOLBELT_AGENT_SOCKET;
	return join(process.env.TOOLBELT_CONFIG_DIR ?? join(homedir(), "Library/Application Support/Toolbelt"), "agent.sock");
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

/** `toolbelt mcp`: pipe stdio to the socket, after a hello line. */
async function mcp(path: string, autonomous: boolean) {
	let socket: Awaited<ReturnType<typeof connect>>;
	try {
		socket = await connect(path, (line) => process.stdout.write(line + "\n"), () => process.exit(0));
	} catch {
		console.error(UNREACHABLE(path));
		process.exit(1);
	}
	socket.write(JSON.stringify({ toolbelt: 1, client: "mcp", mode: autonomous ? "autonomous" : "interactive" }) + "\n");
	const decoder = new TextDecoder();
	for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) socket.write(decoder.decode(chunk, { stream: true }));
	socket.end();
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
	socket.write(JSON.stringify({ toolbelt: 1, client: "toolbelt-cli", mode: autonomous ? "autonomous" : "interactive" }) + "\n");
	const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "toolbelt-cli", version: "1" } });
	if (init.error) throw new Error(init.error.message);
	socket.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
	const response = await request("tools/call", { name: tool, arguments: args });
	socket.end();
	if (response.error) throw new Error(response.error.message);
	return response.result as { content: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean };
}

async function main() {
	const { positional, flags } = parse(process.argv.slice(2));
	const [command, ...rest] = positional;
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
	if (command === "mcp") return mcp(path, autonomous);
	const int = (name: string) => {
		const v = flags.get(name);
		if (typeof v !== "string") return undefined;
		const n = Number(v);
		if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a whole number`);
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
			if (!rest[0]) throw new Error("toolbelt read <plugin> [screen]");
			tool = "read_screen";
			args = {
				plugin: rest[0],
				...(rest[1] ? { screen: rest[1] } : {}),
				...(flags.has("json") ? { format: "json" } : {}),
				...(int("max-rows") !== undefined ? { max_rows: int("max-rows") } : {}),
				...(typeof flags.get("table") === "string" ? { table: flags.get("table") } : {}),
				...(int("offset") !== undefined ? { offset: int("offset") } : {}),
				...(flags.has("no-details") ? { details: false } : {}),
			};
			break;
		case "search":
			if (!rest.length) throw new Error("toolbelt search <words…>");
			tool = "search_screens";
			args = { query: rest.join(" "), ...(plugin ? { plugin } : {}) };
			break;
		case "plugins":
			tool = "list_plugins";
			break;
		default:
			throw new Error(`Unknown command ${command}. Run toolbelt help.`);
	}
	const result = await call(path, autonomous, tool, args);
	if (flags.has("json") && result.structuredContent !== undefined && !result.isError)
		console.log(JSON.stringify(result.structuredContent, null, 2));
	else console.log(result.content.map((c) => c.text).join("\n"));
	if (result.isError) process.exit(2);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
