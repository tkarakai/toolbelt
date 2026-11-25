// The browser transport (remote access and the preview, docs/remote-access.md): one WebSocket to
// the main process that reconnects by itself. Requests in flight when it drops fail; nothing is
// replayed. The server's heartbeat keeps it honest: silence means a dead socket, which mobile
// browsers like to keep around after the phone sleeps.
//
// Each socket first says hello with this device's token (docs/remote-access.md, "Pairing"). The
// server answers "paired", and only then is the connection open, or "unpaired": the person pairs
// with the code or QR code shown on the Mac, and the token that comes back is kept.
import { REMOTE_CLOSE, REMOTE_HEARTBEAT_MS, type PairingServerMessage } from "../../shared/remote";

export type ConnectionStatus =
	/** First connection attempt. */
	| "connecting"
	| "open"
	/** Lost; retrying with backoff. */
	| "offline"
	/** Disconnected from the Mac's Remote Access tab; waits for Reconnect. */
	| "disconnected"
	/** Remote access was turned off on the Mac; retrying slowly. */
	| "off"
	/** Connected, but this device isn't paired with the Mac: waiting for a code. */
	| "unpaired";

const TOKEN_KEY = "toolbelt.device-token";
/** Kept in memory too: without browser storage, pairing lasts until the page closes. */
let memoryToken: string | null = null;
function storedToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
	} catch {
		return memoryToken;
	}
}
/** Keeps the device token; false when browser storage refused it (a reload would forget it). */
function storeToken(token: string | null) {
	memoryToken = token;
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
		return true;
	} catch {
		return false;
	}
}

type Response = { result?: unknown; error?: string };
type Waiting = { resolve: (r: Response) => void; reject: (e: Error) => void };

/** Jittered, capped exponential backoff (ms) for the given attempt. */
export function backoff(attempt: number, random = Math.random, cap = 30_000) {
	const base = Math.min(cap, 1000 * 2 ** attempt);
	return Math.round(base * (0.5 + random() * 0.5));
}

export type SocketTransportOptions = {
	url: string;
	/** A webview message from the main process. */
	message(name: string, payload: unknown): void;
	/** After every successful (re)connection; `again` is false the first time. */
	connected(again: boolean): void;
	/** The page was hidden (surfaces should close) or shown again on a live socket. */
	suspended?(hidden: boolean): void;
	/** How ToolBelt runs here ("Safari", "Home Screen app"), for the paired device's name. */
	label?: () => string;
};

export function createSocketTransport(options: SocketTransportOptions) {
	let ws: WebSocket | null = null;
	let status: ConnectionStatus = "connecting";
	let everConnected = false;
	let attempt = 0;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let stableTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSeen = 0;
	let next = 1;
	const inFlight = new Map<number, Waiting>();
	const openWaiters = new Set<() => void>();
	const statusListeners = new Set<() => void>();
	let probe: (() => void) | null = null;
	let device: { id: string; name: string } | null = null;
	let pairing: { resolve: (stored: boolean) => void; reject: (e: Error) => void } | null = null;

	const setStatus = (s: ConnectionStatus) => {
		if (s === status) return;
		status = s;
		statusListeners.forEach((l) => l());
	};

	const failInFlight = () => {
		for (const w of inFlight.values()) w.reject(new Error("The connection to your Mac was lost"));
		inFlight.clear();
	};

	function detach(socket: WebSocket) {
		socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
	}

	function scheduleRetry(slow = false) {
		clearTimeout(retryTimer);
		retryTimer = setTimeout(connect, slow ? Math.max(15_000, backoff(attempt)) : backoff(attempt));
		attempt++;
	}

	function dropped(code?: number) {
		clearTimeout(stableTimer);
		if (ws) detach(ws);
		ws = null;
		probe = null;
		failInFlight();
		pairing?.reject(new Error("The connection to your Mac was lost"));
		pairing = null;
		if (code === REMOTE_CLOSE.revoked) {
			// Forget the token; the next socket shows the pairing screen.
			storeToken(null);
			device = null;
			setStatus("unpaired");
			attempt = 0;
			return scheduleRetry();
		}
		if (code === REMOTE_CLOSE.disconnected) return setStatus("disconnected");
		if (code === REMOTE_CLOSE.off) {
			setStatus("off");
			return scheduleRetry(true);
		}
		setStatus(everConnected ? "offline" : "connecting");
		scheduleRetry();
	}

	function connect() {
		clearTimeout(retryTimer);
		if (ws) {
			detach(ws);
			ws.close();
		}
		const socket = new WebSocket(options.url);
		ws = socket;
		socket.onopen = () => {
			lastSeen = Date.now();
			const token = storedToken();
			socket.send(JSON.stringify(token ? { kind: "hello", token } : { kind: "hello" }));
		};
		/** The server accepted this device: the connection is open. */
		const admitted = (m: Extract<PairingServerMessage, { kind: "paired" }>) => {
			device = m.device;
			const stored = m.token ? storeToken(m.token) : true;
			// Backoff resets only once the connection has stayed up for a while.
			clearTimeout(stableTimer);
			stableTimer = setTimeout(() => (attempt = 0), 10_000);
			const again = everConnected;
			everConnected = true;
			setStatus("open");
			openWaiters.forEach((w) => w());
			openWaiters.clear();
			options.connected(again);
			pairing?.resolve(stored);
			pairing = null;
		};
		socket.onmessage = (e) => {
			lastSeen = Date.now();
			probe?.();
			let m: { kind?: string; id?: number; name?: string; payload?: unknown; t?: number } & Response;
			try {
				m = JSON.parse(String(e.data));
			} catch {
				return;
			}
			if (m.kind === "ping") return socket.send(JSON.stringify({ kind: "pong", t: m.t }));
			if (m.kind === "paired") return admitted(m as Extract<PairingServerMessage, { kind: "paired" }>);
			if (m.kind === "unpaired") {
				// A token the Mac no longer knows: forget it.
				if (storedToken()) storeToken(null);
				device = null;
				return setStatus("unpaired");
			}
			if (m.kind === "pairFailed") {
				pairing?.reject(new Error(String((m as { error?: unknown }).error ?? "Pairing failed")));
				pairing = null;
				return;
			}
			if (m.kind === "response" && typeof m.id === "number") {
				inFlight.get(m.id)?.resolve(m);
				inFlight.delete(m.id);
			} else if (m.kind === "message" && typeof m.name === "string") options.message(m.name, m.payload);
		};
		socket.onclose = (e) => {
			if (ws === socket) dropped(e.code);
		};
		socket.onerror = () => {
			// onclose follows.
		};
	}

	/** Waits for an open socket (up to `ms`). */
	const whenOpen = (ms: number) =>
		new Promise<void>((resolve, reject) => {
			if (status === "open" && ws?.readyState === WebSocket.OPEN) return resolve();
			let timer: ReturnType<typeof setTimeout>;
			const expire = () => {
				// While the person pairs, requests wait: the page reloads once paired.
				if (status === "unpaired") return void (timer = setTimeout(expire, 1_000));
				openWaiters.delete(done);
				reject(new Error("Not connected to your Mac"));
			};
			timer = setTimeout(expire, ms);
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			openWaiters.add(done);
		});

	async function request(method: string, params: unknown) {
		// Plugin actions are never queued: an action taken while offline must not run later.
		if (method === "event" && status !== "open") throw new Error("Not connected to your Mac");
		await whenOpen(method === "event" ? 0 : 15_000);
		const id = next++;
		const response = await new Promise<Response>((resolve, reject) => {
			inFlight.set(id, { resolve, reject });
			ws!.send(JSON.stringify({ kind: "request", id, method, params }));
		});
		if (response.error) throw new Error(response.error);
		return response.result;
	}

	function send(name: string, payload: unknown) {
		if (status === "open" && ws?.readyState === WebSocket.OPEN)
			ws.send(JSON.stringify({ kind: "message", name, payload }));
	}

	/** Is the open socket really alive? Any message within `ms` counts. */
	function check(ms = 3_000) {
		if (!ws || status !== "open") return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				probe = null;
				resolve(false);
			}, ms);
			probe = () => {
				clearTimeout(timer);
				probe = null;
				resolve(true);
			};
			ws!.send(JSON.stringify({ kind: "ping", t: Date.now() }));
		});
	}

	/**
	 * Pairs with the six-digit code or the QR code's secret. Resolves once paired, with whether the
	 * token was kept in browser storage; rejects with the Mac's reason (wrong code, expired, …).
	 */
	function pair(secret: string) {
		if (status !== "unpaired" || ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected to your Mac"));
		pairing?.reject(new Error("Replaced by a newer attempt"));
		return new Promise<boolean>((resolve, reject) => {
			pairing = { resolve, reject };
			ws!.send(JSON.stringify({ kind: "pair", secret, label: options.label?.() ?? "" }));
		});
	}

	/** Reconnect now (after the network returns, or the person asks). */
	function reconnect() {
		attempt = 0;
		if (status === "disconnected" || status === "off") setStatus(everConnected ? "offline" : "connecting");
		connect();
	}

	// Silence for 2.5 heartbeats: the socket is dead even if the browser hasn't noticed.
	setInterval(() => {
		if ((status === "open" || (status === "unpaired" && ws)) && Date.now() - lastSeen > REMOTE_HEARTBEAT_MS * 2.5) {
			ws?.close();
			dropped();
		}
	}, 5_000);

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			if (status === "open") options.suspended?.(true);
			return;
		}
		if (status === "open")
			void check().then((alive) => {
				if (alive) options.suspended?.(false);
				else {
					ws?.close();
					dropped();
					reconnect();
				}
			});
		else if (status === "offline" || status === "connecting" || status === "off" || (status === "unpaired" && !ws)) reconnect();
	});
	window.addEventListener("online", () => {
		if (status !== "open" && status !== "disconnected") reconnect();
	});

	connect();
	return {
		request,
		send,
		reconnect,
		pair,
		/** The paired device this connection presented (null in the preview or until paired). */
		device: () => device,
		status: () => status,
		subscribe(listener: () => void) {
			statusListeners.add(listener);
			return () => void statusListeners.delete(listener);
		},
	};
}
