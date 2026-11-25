// Channel adapters for agent scenarios: each runs scenario steps over one transport, the way a
// real client would. A new MCP server or CLI needs only a new adapter here.
import { join } from "node:path";
import type { Channel, Tool } from "./format";

export const CLI = join(import.meta.dir, "../../src/cli/toolbelt.ts");

/** What one step returned. `text` is what an agent would read. */
export type Outcome = { text: string; refused: boolean; unreachable: boolean };
export type Received = { method: string; params: any; at: number };

export interface ChannelAdapter {
	readonly channel: Channel;
	/** Whether resource steps and notifications work on this channel. */
	readonly resources: boolean;
	/** Connects before the scenario starts, if the channel keeps a session (to see notifications). */
	start?(): Promise<void>;
	call(tool: Tool, args: Record<string, unknown>, structured: boolean): Promise<Outcome>;
	read?(uri: string): Promise<Outcome>;
	subscribe?(uri: string): Promise<Outcome>;
	unsubscribe?(uri: string): Promise<Outcome>;
	/** Notifications received so far. */
	notifications?(): Received[];
	close(): Promise<void>;
}

export const uriOf = (screen: string) => `toolbelt://screens/${screen}`;
/** Structured output in one canonical form, so facts match across channels. */
const compact = (value: unknown) => JSON.stringify(value);

type Options = { socket: string; autonomous: boolean; client?: string };

/** An MCP client that starts the real stdio shim (`toolbelt mcp`), as Claude Code does. */
export class McpAdapter implements ChannelAdapter {
	readonly channel = "mcp";
	readonly resources = true;
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private pending = new Map<number, (m: any) => void>();
	private received: Received[] = [];
	private next = 1;
	private alive = false;
	readonly lines: string[] = [];

	constructor(private readonly o: Options) {}

	async start() {
		await this.connection();
	}

	/** The raw JSON-RPC connection: starts the shim if it isn't running. Null when it can't. */
	async connection(initialize = true): Promise<{ request: (method: string, params?: unknown) => Promise<any>; send: (m: unknown) => void } | null> {
		if (!this.alive) {
			const proc = Bun.spawn([process.execPath, CLI, "--socket", this.o.socket, "mcp", ...(this.o.autonomous ? ["--autonomous"] : [])], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			this.proc = proc;
			this.alive = true;
			void proc.exited.then(() => {
				if (this.proc === proc) this.closed();
			});
			void this.pump(proc);
			if (initialize) {
				const init = await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: this.o.client ?? "scenario-agent", version: "1" } });
				if (init.closed) return null;
				this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
				// Requests are answered in order: once ping returns, the server has seen `initialized`.
				await this.request("ping");
			}
		}
		return { request: (m, p) => this.request(m, p), send: (m) => this.send(m) };
	}

	private async pump(proc: ReturnType<typeof Bun.spawn>) {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let i: number;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				if (!line.trim()) continue;
				this.lines.push(line);
				const m = JSON.parse(line);
				if (m.id !== undefined && this.pending.has(m.id)) {
					this.pending.get(m.id)!(m);
					this.pending.delete(m.id);
				} else if (m.method) this.received.push({ method: m.method, params: m.params, at: Date.now() });
			}
		}
	}

	private send(message: unknown) {
		if (!this.alive || !this.proc) return;
		const stdin = this.proc.stdin as import("bun").FileSink;
		// The shim exits when ToolBelt closes the socket (agents turned off), possibly between
		// the alive check and the write: that's a closed connection, as a client would see it.
		try {
			stdin.write(JSON.stringify(message) + "\n");
			void Promise.resolve(stdin.flush()).catch(() => this.closed());
		} catch {
			this.closed();
		}
	}

	private closed() {
		this.alive = false;
		for (const resolve of this.pending.values()) resolve({ closed: true });
		this.pending.clear();
	}

	private request(method: string, params: unknown = {}) {
		return new Promise<any>((resolve) => {
			if (!this.alive) return resolve({ closed: true });
			const id = this.next++;
			this.pending.set(id, resolve);
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	private async rpc(method: string, params: unknown): Promise<{ result?: any; error?: any } | null> {
		const c = await this.connection();
		if (!c) return null;
		const r = await c.request(method, params);
		return r.closed ? null : r;
	}

	private static unreachable: Outcome = { text: "", refused: false, unreachable: true };

	async call(tool: Tool, args: Record<string, unknown>, structured: boolean): Promise<Outcome> {
		const r = await this.rpc("tools/call", { name: tool, arguments: args });
		if (!r) return McpAdapter.unreachable;
		if (r.error) return { text: r.error.message, refused: true, unreachable: false };
		const text = structured && r.result.structuredContent !== undefined ? compact(r.result.structuredContent) : r.result.content.map((c: { text: string }) => c.text).join("\n");
		return { text, refused: r.result.isError === true, unreachable: false };
	}

	async read(uri: string): Promise<Outcome> {
		const r = await this.rpc("resources/read", { uri });
		if (!r) return McpAdapter.unreachable;
		if (r.error) return { text: r.error.message, refused: true, unreachable: false };
		return { text: r.result.contents.map((c: { text: string }) => c.text).join("\n"), refused: false, unreachable: false };
	}

	async subscribe(uri: string): Promise<Outcome> {
		const r = await this.rpc("resources/subscribe", { uri });
		if (!r) return McpAdapter.unreachable;
		return { text: r.error?.message ?? "", refused: !!r.error, unreachable: false };
	}

	async unsubscribe(uri: string): Promise<Outcome> {
		const r = await this.rpc("resources/unsubscribe", { uri });
		if (!r) return McpAdapter.unreachable;
		return { text: r.error?.message ?? "", refused: !!r.error, unreachable: false };
	}

	notifications() {
		return this.received;
	}

	async close() {
		const proc = this.proc;
		if (!proc) return;
		(proc.stdin as import("bun").FileSink).end();
		await Promise.race([proc.exited, Bun.sleep(1000)]);
		proc.kill();
	}
}

/** The `toolbelt` command: one process per call, as a shell script or coding agent runs it. */
export class CliAdapter implements ChannelAdapter {
	readonly channel = "cli";
	readonly resources = false;
	constructor(private readonly o: Options) {}

	/** The command line for a tool call: the CLI's documented mapping (`toolbelt help`). */
	static argv(tool: Tool, args: Record<string, unknown>, structured: boolean): string[] {
		const known = (allowed: string[]) => {
			for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new Error(`the CLI has no option for ${tool} ${k}`);
		};
		const json = structured ? ["--json"] : [];
		switch (tool) {
			case "toolbelt_status":
				known([]);
				return ["status", ...json];
			case "list_plugins":
				known([]);
				return ["plugins", ...json];
			case "list_screens":
				known(["plugin"]);
				return ["screens", ...(args.plugin ? [String(args.plugin)] : []), ...json];
			case "search_screens":
				known(["query", "plugin"]);
				return ["search", ...String(args.query).split(/\s+/), ...(args.plugin ? ["--plugin", String(args.plugin)] : []), ...json];
			case "read_screen":
				known(["plugin", "screen", "format", "max_rows", "table", "offset", "details"]);
				return [
					"read",
					String(args.plugin),
					...(args.screen ? [String(args.screen)] : []),
					...(args.max_rows !== undefined ? ["--max-rows", String(args.max_rows)] : []),
					...(args.table !== undefined ? ["--table", String(args.table)] : []),
					...(args.offset !== undefined ? ["--offset", String(args.offset)] : []),
					...(args.details === false ? ["--no-details"] : []),
					...(args.format === "json" || structured ? ["--json"] : []),
				];
		}
	}

	async call(tool: Tool, args: Record<string, unknown>, structured: boolean): Promise<Outcome> {
		const argv = CliAdapter.argv(tool, args, structured);
		const p = Bun.spawn([process.execPath, CLI, "--socket", this.o.socket, ...(this.o.autonomous ? ["--autonomous"] : []), ...argv], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		let text = out.trimEnd();
		if (argv.includes("--json") && code === 0) text = compact(JSON.parse(text));
		return { text: code === 1 ? err.trim() : text, refused: code === 2, unreachable: code === 1 };
	}

	async close() {}
}

export function adapter(channel: Channel, o: Options): ChannelAdapter {
	return channel === "mcp" ? new McpAdapter(o) : new CliAdapter(o);
}
