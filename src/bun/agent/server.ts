// The agent socket (docs/agent-interface.md): a Unix domain socket only this user can open. Each
// connection starts with a hello line ({"toolbelt":1,"client":…,"mode":…}), then speaks MCP
// JSON-RPC, one message per line. The stdio shim (`toolbelt mcp`) and the CLI connect here.
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { Socket, UnixSocketListener } from "bun";
import type { AgentHello } from "../../shared/agents";
import type { AgentCore } from "./core";
import { McpSession } from "./mcp";

const MAX_LINE = 1024 * 1024;

type Connection = {
	buffer: string;
	decoder: TextDecoder;
	session: McpSession | null;
	queue: Promise<void>;
	out: Buffer[];
};

/** Whether something already answers on the socket path. */
async function answers(path: string) {
	try {
		const socket = await Bun.connect({ unix: path, socket: { data() {}, open() {}, close() {}, error() {} } });
		socket.end();
		return true;
	} catch {
		return false;
	}
}

export class AgentServer {
	private listener: UnixSocketListener<Connection> | null = null;
	private connections = new Set<Socket<Connection>>();

	constructor(
		private readonly core: AgentCore,
		readonly path: string,
	) {}

	get listening() {
		return !!this.listener;
	}

	async start() {
		if (this.listener) return;
		try {
			if (existsSync(this.path)) {
				if (await answers(this.path)) throw new Error(`Another ToolBelt already serves agents at ${this.path}`);
				unlinkSync(this.path);
			}
			this.listener = Bun.listen<Connection>({
				unix: this.path,
				socket: {
					open: (socket) => {
						socket.data = { buffer: "", decoder: new TextDecoder(), session: null, queue: Promise.resolve(), out: [] };
						this.connections.add(socket);
					},
					data: (socket, chunk) => this.receive(socket, socket.data.decoder.decode(chunk, { stream: true })),
					drain: (socket) => this.flush(socket),
					close: (socket) => this.closed(socket),
					error: (socket) => this.closed(socket),
				},
			});
			chmodSync(this.path, 0o600);
			this.core.setRunning(true, null);
		} catch (error) {
			this.listener = null;
			this.core.setRunning(false, error instanceof Error ? error.message : String(error));
		}
	}

	stop() {
		for (const socket of this.connections) socket.end();
		this.connections.clear();
		this.listener?.stop(true);
		this.listener = null;
		try {
			if (existsSync(this.path)) unlinkSync(this.path);
		} catch {}
		this.core.setRunning(false, null);
		this.core.stop();
	}

	private write(socket: Socket<Connection>, message: unknown) {
		socket.data.out.push(Buffer.from(JSON.stringify(message) + "\n"));
		this.flush(socket);
	}

	private flush(socket: Socket<Connection>) {
		const out = socket.data.out;
		while (out.length) {
			const written = socket.write(out[0]);
			if (written < out[0].length) {
				out[0] = out[0].subarray(Math.max(0, written));
				return;
			}
			out.shift();
		}
	}

	private receive(socket: Socket<Connection>, text: string) {
		const c = socket.data;
		c.buffer += text;
		if (c.buffer.length > MAX_LINE && !c.buffer.includes("\n")) {
			socket.end();
			return;
		}
		let index: number;
		while ((index = c.buffer.indexOf("\n")) >= 0) {
			const line = c.buffer.slice(0, index).trim();
			c.buffer = c.buffer.slice(index + 1);
			if (!line) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				this.write(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
				continue;
			}
			if (!c.session) {
				const hello = message as Partial<AgentHello>;
				if (hello?.toolbelt !== 1) {
					socket.end();
					return;
				}
				const session = this.core.openSession(
					typeof hello.client === "string" ? hello.client : "agent",
					hello.mode === "autonomous" ? "autonomous" : "interactive",
				);
				c.session = new McpSession(this.core, session, (m) => this.write(socket, m));
				continue;
			}
			const session = c.session;
			c.queue = c.queue.then(() => session.handle(message as never)).catch(() => {});
		}
	}

	private closed(socket: Socket<Connection>) {
		if (!this.connections.delete(socket)) return;
		const session = socket.data?.session;
		if (session) {
			session.close();
			this.core.closeSession(session.session);
		}
	}
}
