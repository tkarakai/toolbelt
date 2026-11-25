// The WebSocket RPC server behind remote access (docs/remote-access.md) and the browser preview.
// It serves the built UI, bridges the web view RPC over `/rpc`, and keeps each connection's
// outgoing render trees to the newest per surface when the link falls behind.
import type { Server, ServerWebSocket } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { REMOTE_HEARTBEAT_MS, type PairingServerMessage } from "../shared/remote";

// ── request checks ───────────────────────────────────────────────────────

export type Verdict = { ok: true; ip: string | null } | { ok: false; status: number; reason: string };

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];
const isLoopbackAddress = (address: string | undefined) =>
	!!address && (address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1");

/**
 * Remote access accepts a request only when it came through Tailscale Serve for the owner:
 * from a loopback peer, for an allowed host, from its own origin, carrying the owner's login.
 * Serve strips client-supplied `Tailscale-User-Login` headers before adding its own.
 */
export function checkRemoteRequest(
	request: Request,
	peerAddress: string | undefined,
	expected: { owner: string | null; dnsName: string | null },
	options: { requireOwner?: boolean } = {},
): Verdict {
	if (!isLoopbackAddress(peerAddress)) return { ok: false, status: 403, reason: "Not through Tailscale Serve" };
	const host = request.headers.get("host") ?? "";
	const hostname = host.replace(/:\d+$/, "").toLowerCase();
	const allowed = [...LOOPBACK_NAMES, ...(expected.dnsName ? [expected.dnsName.toLowerCase()] : [])];
	if (!allowed.includes(hostname)) return { ok: false, status: 403, reason: "Unknown host" };
	const origin = request.headers.get("origin");
	if (origin) {
		let originHost: string;
		try {
			originHost = new URL(origin).host.toLowerCase();
		} catch {
			return { ok: false, status: 403, reason: "Forbidden origin" };
		}
		if (originHost !== host.toLowerCase()) return { ok: false, status: 403, reason: "Forbidden origin" };
	}
	if (options.requireOwner !== false) {
		const login = request.headers.get("tailscale-user-login");
		if (!expected.owner) return { ok: false, status: 503, reason: "Tailscale owner unknown" };
		if (!login || login !== expected.owner)
			return { ok: false, status: 403, reason: "Only the Tailscale account that owns this Mac can connect" };
	}
	// Serve tells the backend who is connecting; only a loopback peer may say so.
	const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
	return { ok: true, ip: forwarded };
}

// ── outgoing messages ────────────────────────────────────────────────────

/** Above this many buffered bytes a connection counts as behind. */
export const BACKPRESSURE_BYTES = 256 * 1024;

type Pending = { key?: string; data: string };

/**
 * Sends messages in order. While the socket is behind, they wait; a render tree waiting for
 * a surface is replaced by a newer one for the same surface (counted as skipped). Nothing
 * else is ever dropped.
 */
export class OutboundQueue {
	private pending: Pending[] = [];
	treesSent = 0;
	treesSkipped = 0;
	bytesOut = 0;

	constructor(
		private readonly write: (data: string) => void,
		private readonly buffered: () => number,
		private readonly limit = BACKPRESSURE_BYTES,
	) {}

	push(data: string, key?: string) {
		if (!this.pending.length && this.buffered() < this.limit) return this.send({ data, key });
		if (key) {
			const waiting = this.pending.find((p) => p.key === key);
			if (waiting) {
				waiting.data = data;
				this.treesSkipped++;
				return;
			}
		}
		this.pending.push({ data, key });
	}

	/** Called when the socket drains. */
	flush() {
		while (this.pending.length && this.buffered() < this.limit) this.send(this.pending.shift()!);
	}

	get waiting() {
		return this.pending.length;
	}

	private send(p: Pending) {
		if (p.key) this.treesSent++;
		this.bytesOut += Buffer.byteLength(p.data);
		this.write(p.data);
	}
}

// ── server ───────────────────────────────────────────────────────────────

export type RemoteClient = {
	id: number;
	/** The device's tailnet IP (from Serve), or null for local connections. */
	ip: string | null;
	userAgent: string;
	connectedAt: number;
	opened: Set<string>;
	queue: OutboundQueue;
	bytesIn: number;
	/** Sampled compression ratio of outgoing messages (wire/uncompressed). */
	ratio: number;
	rtt: number | null;
	/** The paired device this connection presented (null without pairing). */
	device: { id: string; name: string } | null;
	send(name: string, payload: unknown): void;
	close(code: number, reason: string): void;
};

/**
 * Device pairing (src/bun/pairing.ts). With it, a connection must present a paired device's token
 * or pair before it is "opened": until then it gets no messages and every request fails.
 */
export type ServerPairing = {
	verify(token: unknown): { id: string; name: string } | null;
	pair(secret: unknown, label: unknown, client: RemoteClient): { token: string; device: { id: string; name: string } } | { error: string };
};

const NOT_PAIRED = "Pair this device with your Mac first";

export type RemoteServerOptions = {
	port: number;
	hostname?: string;
	/** Built UI (index.html, assets/, sw.js, manifest). */
	root: string;
	/** Accept or refuse a request before anything is served. */
	check(request: Request, peerAddress: string | undefined): Verdict;
	/**
	 * Before the RPC socket opens: whether the process on the client end of the loopback
	 * connection may speak for Serve (src/bun/peer-owner.ts). Static files skip it: they are the
	 * public UI build.
	 */
	trustPeer?(clientPort: number, serverPort: number): Promise<boolean>;
	/** Answers `/.well-known/toolbelt`, checked without the owner requirement. */
	wellKnown?: { check(request: Request, peerAddress: string | undefined): Verdict; body: () => unknown };
	request(client: RemoteClient, method: string, params: Record<string, unknown>): unknown;
	message?(client: RemoteClient, name: string, payload: unknown): void;
	opened?(client: RemoteClient): void;
	closed?(client: RemoteClient): void;
	/** Requires device pairing before a connection opens (remote access; not the preview). */
	pairing?: ServerPairing;
	/** Extra HTTP routes (the preview's update simulation). */
	route?(request: Request, url: URL): Response | undefined | Promise<Response | undefined>;
	heartbeatMs?: number;
};

type Data = { client?: RemoteClient; ip: string | null; userAgent: string };

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
	"content-security-policy": "frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

/** The main script's file name in index.html: it changes with every UI build. */
export function buildIdOf(root: string): string | null {
	try {
		const html = readFileSync(join(root, "index.html"), "utf8");
		return html.match(/<script[^>]+src="[^"]*?([^"/]+\.js)"/)?.[1] ?? null;
	} catch {
		return null;
	}
}

/** A file under `root` for a URL path, or null (traversal, missing, directory). */
export function staticFile(root: string, pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;
	const base = resolve(root);
	const path = resolve(base, "." + normalize(decoded === "/" ? "/index.html" : decoded));
	if (path !== base && !path.startsWith(base + sep)) return null;
	try {
		return existsSync(path) && statSync(path).isFile() ? path : null;
	} catch {
		return null;
	}
}

function serveFile(root: string, pathname: string): Response {
	const path = staticFile(root, pathname);
	if (!path) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
	const name = path.slice(resolve(root).length);
	// Hashed build output never changes; the shell, worker and manifest must revalidate.
	const immutable = name.startsWith(`${sep}assets${sep}`);
	return new Response(Bun.file(path), {
		headers: {
			...SECURITY_HEADERS,
			"content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
			"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
		},
	});
}

let nextId = 1;

export function startRemoteServer(options: RemoteServerOptions) {
	/** Connections that identified themselves (or all, without pairing): they get messages. */
	const clients = new Set<RemoteClient>();
	/** Connections still to present a token or pair. */
	const unpaired = new Set<RemoteClient>();
	const admit = (client: RemoteClient) => {
		unpaired.delete(client);
		clients.add(client);
		options.opened?.(client);
	};
	const answer = (client: RemoteClient, message: PairingServerMessage) => client.queue.push(JSON.stringify(message));
	const sampleEvery = 8;
	let sent = 0;
	const server: Server<Data> = Bun.serve<Data>({
		port: options.port,
		hostname: options.hostname ?? "127.0.0.1",
		async fetch(request, server) {
			const url = new URL(request.url);
			const address = server.requestIP(request);
			const peer = address?.address;
			if (url.pathname === "/.well-known/toolbelt" && options.wellKnown) {
				const verdict = options.wellKnown.check(request, peer);
				if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status, headers: SECURITY_HEADERS });
				return Response.json(options.wellKnown.body(), { headers: { ...SECURITY_HEADERS, "cache-control": "no-store" } });
			}
			const verdict = options.check(request, peer);
			if (!verdict.ok) return new Response(verdict.reason, { status: verdict.status, headers: SECURITY_HEADERS });
			if (url.pathname === "/rpc") {
				if (options.trustPeer && !(address && (await options.trustPeer(address.port, server.port!))))
					return new Response("Only Tailscale on this Mac can connect", { status: 403, headers: SECURITY_HEADERS });
				return server.upgrade(request, {
					data: { ip: verdict.ip, userAgent: request.headers.get("user-agent") ?? "" },
				})
					? undefined
					: new Response("Expected a WebSocket", { status: 400 });
			}
			const routed = await options.route?.(request, url);
			if (routed) return routed;
			if (request.method !== "GET" && request.method !== "HEAD")
				return new Response("Method not allowed", { status: 405 });
			return serveFile(options.root, url.pathname);
		},
		websocket: {
			perMessageDeflate: true,
			maxPayloadLength: 16 * 1024 * 1024,
			open(ws: ServerWebSocket<Data>) {
				const write = (data: string) => {
					// Sample how well messages compress, for the wire estimate.
					if (++sent % sampleEvery === 0 && data.length > 512) {
						const bytes = Buffer.from(data);
						const compressed = Bun.deflateSync(bytes).length;
						client.ratio = client.ratio * 0.7 + (compressed / bytes.length) * 0.3;
					}
					ws.send(data);
				};
				const client: RemoteClient = {
					id: nextId++,
					ip: ws.data.ip,
					userAgent: ws.data.userAgent,
					connectedAt: Date.now(),
					opened: new Set(),
					queue: new OutboundQueue(write, () => ws.getBufferedAmount()),
					bytesIn: 0,
					ratio: 0.25,
					rtt: null,
					device: null,
					send(name, payload) {
						const data = JSON.stringify({ kind: "message", name, payload });
						const tree = name === "tree" ? (payload as { plugin: string; surface: string }) : null;
						client.queue.push(data, tree ? `${tree.plugin}\n${tree.surface}` : undefined);
					},
					close: (code, reason) => ws.close(code, reason),
				};
				ws.data.client = client;
				if (options.pairing) unpaired.add(client);
				else admit(client);
			},
			drain(ws) {
				ws.data.client?.queue.flush();
			},
			close(ws) {
				const client = ws.data.client;
				if (!client) return;
				unpaired.delete(client);
				if (clients.delete(client)) options.closed?.(client);
			},
			async message(ws, raw) {
				const client = ws.data.client;
				if (!client) return;
				const text = typeof raw === "string" ? raw : raw.toString();
				client.bytesIn += typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
				let m: { kind?: string; id?: number; method?: string; params?: unknown; name?: string; payload?: unknown; t?: number };
				try {
					m = JSON.parse(text);
				} catch {
					return;
				}
				if (m.kind === "ping") return client.queue.push(JSON.stringify({ kind: "pong", t: m.t }));
				if (m.kind === "pong") {
					if (typeof m.t === "number") client.rtt = Math.max(0, Date.now() - m.t);
					return;
				}
				const admitted = clients.has(client);
				if (m.kind === "hello") {
					if (admitted) return answer(client, { kind: "paired", device: client.device });
					const device = options.pairing?.verify((m as { token?: unknown }).token);
					if (!device) return answer(client, { kind: "unpaired" });
					client.device = device;
					answer(client, { kind: "paired", device });
					return admit(client);
				}
				if (m.kind === "pair") {
					if (admitted || !options.pairing) return answer(client, { kind: "paired", device: client.device });
					const { secret, label } = m as { secret?: unknown; label?: unknown };
					const result = options.pairing.pair(secret, label, client);
					if ("error" in result) return answer(client, { kind: "pairFailed", error: result.error });
					client.device = result.device;
					answer(client, { kind: "paired", device: result.device, token: result.token });
					return admit(client);
				}
				if (!admitted) {
					if (m.kind === "request" && typeof m.id === "number")
						client.queue.push(JSON.stringify({ kind: "response", id: m.id, error: NOT_PAIRED }));
					return;
				}
				if (m.kind === "message" && typeof m.name === "string") return options.message?.(client, m.name, m.payload);
				if (m.kind !== "request" || typeof m.id !== "number" || typeof m.method !== "string") return;
				const reply = (body: { result?: unknown; error?: string }) =>
					client.queue.push(JSON.stringify({ kind: "response", id: m.id, ...body }));
				try {
					const params = m.params && typeof m.params === "object" ? (m.params as Record<string, unknown>) : {};
					reply({ result: await options.request(client, m.method, params) });
				} catch (error) {
					reply({ error: error instanceof Error ? error.message : String(error) });
				}
			},
		},
	});
	const heartbeat = setInterval(() => {
		const t = Date.now();
		for (const client of [...clients, ...unpaired]) client.queue.push(JSON.stringify({ kind: "ping", t }));
	}, options.heartbeatMs ?? REMOTE_HEARTBEAT_MS);
	return {
		port: server.port,
		clients,
		/** Sends a webview message to every connection. */
		broadcast(name: string, payload: unknown) {
			for (const client of clients) client.send(name, payload);
		},
		/** Closes every connection with `code`, then frees the port. */
		async stop(code: number, reason: string) {
			clearInterval(heartbeat);
			const all = [...clients, ...unpaired];
			for (const client of all) client.close(code, reason);
			// Let the close frames go out before the listener and sockets are torn down.
			await Bun.sleep(all.length ? 200 : 0);
			await server.stop(true);
		},
	};
}

export type RemoteServer = ReturnType<typeof startRemoteServer>;

/** A webview `send` object whose methods forward to a remote client. */
export const remoteSender = <T>(client: RemoteClient) =>
	new Proxy({}, { get: (_, name: string) => (payload: unknown) => client.send(name, payload) }) as T;
