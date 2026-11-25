import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildIdOf,
	checkRemoteRequest,
	OutboundQueue,
	startRemoteServer,
	staticFile,
	type RemoteServer,
} from "../src/bun/remote-server";

const owner = { owner: "owner@example.com", dnsName: "mac.example-tailnet.ts.net" };
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
const serve = (headers: Record<string, string> = {}) =>
	req("http://127.0.0.1:47380/", {
		host: "mac.example-tailnet.ts.net:47380",
		"tailscale-user-login": "owner@example.com",
		"x-forwarded-for": "100.64.0.2",
		...headers,
	});

describe("request checks", () => {
	test("accepts the owner through Serve and reports the device's tailnet IP", () => {
		expect(checkRemoteRequest(serve(), "127.0.0.1", owner)).toEqual({ ok: true, ip: "100.64.0.2" });
		expect(checkRemoteRequest(serve({ origin: "https://mac.example-tailnet.ts.net:47380" }), "::1", owner).ok).toBe(true);
	});

	test("refuses other logins, missing logins and an unknown owner", () => {
		expect(checkRemoteRequest(serve({ "tailscale-user-login": "guest@example.com" }), "127.0.0.1", owner)).toMatchObject({ ok: false, status: 403 });
		const { "tailscale-user-login": _, ...rest } = Object.fromEntries(serve().headers);
		expect(checkRemoteRequest(req("http://127.0.0.1:47380/", rest), "127.0.0.1", owner)).toMatchObject({ ok: false, status: 403 });
		expect(checkRemoteRequest(serve(), "127.0.0.1", { ...owner, owner: null })).toMatchObject({ ok: false, status: 503 });
	});

	test("refuses peers that aren't loopback, rebound hosts and cross-site origins", () => {
		expect(checkRemoteRequest(serve(), "100.64.0.2", owner).ok).toBe(false);
		expect(checkRemoteRequest(serve({ host: "attacker.example:47380" }), "127.0.0.1", owner).ok).toBe(false);
		expect(checkRemoteRequest(serve({ origin: "https://attacker.example" }), "127.0.0.1", owner).ok).toBe(false);
		expect(checkRemoteRequest(serve({ origin: "not a url" }), "127.0.0.1", owner).ok).toBe(false);
	});

	test("the reachability endpoint can skip the owner requirement but not the other checks", () => {
		const anonymous = req("http://127.0.0.1:47380/.well-known/toolbelt", { host: "mac.example-tailnet.ts.net:47380" });
		expect(checkRemoteRequest(anonymous, "127.0.0.1", owner, { requireOwner: false }).ok).toBe(true);
		expect(checkRemoteRequest(anonymous, "127.0.0.1", owner).ok).toBe(false);
		expect(checkRemoteRequest(anonymous, "100.64.0.9", owner, { requireOwner: false }).ok).toBe(false);
	});
});

describe("outbound queue", () => {
	test("sends straight through while the socket keeps up", () => {
		const sent: string[] = [];
		const q = new OutboundQueue((d) => sent.push(d), () => 0, 10);
		q.push("a", "p\ns");
		q.push("b");
		expect(sent).toEqual(["a", "b"]);
		expect(q.treesSent).toBe(1);
	});

	test("while behind, only the newest tree per surface waits; other messages keep their order", () => {
		const sent: string[] = [];
		let buffered = 100;
		const q = new OutboundQueue((d) => sent.push(d), () => buffered, 10);
		q.push("tree1", "p\nmain");
		q.push("toast");
		q.push("tree2", "p\nmain");
		q.push("other", "p\nquick");
		q.push("tree3", "p\nmain");
		expect(sent).toEqual([]);
		expect(q.treesSkipped).toBe(2);
		buffered = 0;
		q.flush();
		expect(sent).toEqual(["tree3", "toast", "other"]);
		expect(q.waiting).toBe(0);
	});
});

describe("static files", () => {
	const root = mkdtempSync(join(tmpdir(), "toolbelt-remote-"));
	mkdirSync(join(root, "assets"));
	writeFileSync(join(root, "index.html"), `<script type="module" crossorigin src="./assets/index-AbC123.js"></script>`);
	writeFileSync(join(root, "assets", "index-AbC123.js"), "console.log(1)");

	test("stay inside the root", () => {
		expect(staticFile(root, "/")).toBe(join(root, "index.html"));
		expect(staticFile(root, "/assets/index-AbC123.js")).toBe(join(root, "assets", "index-AbC123.js"));
		expect(staticFile(root, "/../../etc/passwd")).toBeNull();
		expect(staticFile(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
		expect(staticFile(root, "/assets")).toBeNull();
		expect(staticFile(root, "/%E0%A4%A")).toBeNull();
	});

	test("the build ID is the main script's hashed name", () => {
		expect(buildIdOf(root)).toBe("index-AbC123.js");
		expect(buildIdOf(join(root, "missing"))).toBeNull();
	});
});

describe("server", () => {
	let server: RemoteServer | null = null;
	afterEach(async () => {
		await server?.stop(1000, "done");
		server = null;
	});
	const root = mkdtempSync(join(tmpdir(), "toolbelt-remote-"));
	mkdirSync(join(root, "assets"));
	writeFileSync(join(root, "index.html"), "<p>shell</p>");
	writeFileSync(join(root, "assets", "app-1.js"), "1");

	function start(extra: Partial<Parameters<typeof startRemoteServer>[0]> = {}) {
		server = startRemoteServer({
			port: 0,
			root,
			check: (request, peer) => checkRemoteRequest(request, peer, { owner: "owner@example.com", dnsName: null }),
			wellKnown: {
				check: (request, peer) => checkRemoteRequest(request, peer, { owner: null, dnsName: null }, { requireOwner: false }),
				body: () => ({ instance: "abc" }),
			},
			request: (_client, method, params) => {
				if (method === "echo") return params;
				throw new Error(`Unknown method ${method}`);
			},
			heartbeatMs: 50,
			...extra,
		});
		return server;
	}
	const headers = { "tailscale-user-login": "owner@example.com" };

	test("serves the shell for the owner only, with caching and framing headers", async () => {
		const { port } = start();
		const denied = await fetch(`http://127.0.0.1:${port}/`);
		expect(denied.status).toBe(403);
		const shell = await fetch(`http://127.0.0.1:${port}/`, { headers });
		expect(await shell.text()).toBe("<p>shell</p>");
		expect(shell.headers.get("cache-control")).toBe("no-cache");
		expect(shell.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
		const asset = await fetch(`http://127.0.0.1:${port}/assets/app-1.js`, { headers });
		expect(asset.headers.get("cache-control")).toContain("immutable");
		const known = await fetch(`http://127.0.0.1:${port}/.well-known/toolbelt`);
		expect(await known.json()).toEqual({ instance: "abc" });
	});

	test("answers requests, heartbeats and closes with the requested code", async () => {
		const { port } = start();
		const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers } as never);
		const messages: { kind: string; id?: number; result?: unknown; error?: string }[] = [];
		ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
		await new Promise((ok) => (ws.onopen = ok));
		ws.send(JSON.stringify({ kind: "request", id: 1, method: "echo", params: { a: 1 } }));
		ws.send(JSON.stringify({ kind: "request", id: 2, method: "nope" }));
		ws.send(JSON.stringify({ kind: "ping", t: 5 }));
		await Bun.sleep(150);
		expect(messages.find((m) => m.id === 1)?.result).toEqual({ a: 1 });
		expect(messages.find((m) => m.id === 2)?.error).toBe("Unknown method nope");
		expect(messages.some((m) => m.kind === "pong")).toBe(true);
		expect(messages.some((m) => m.kind === "ping")).toBe(true);
		const client = [...server!.clients][0]!;
		client.send("tree", { plugin: "p", surface: "s", tree: { type: "text" } });
		await Bun.sleep(50);
		expect(messages.some((m) => m.kind === "message")).toBe(true);
		const closed = new Promise<number>((ok) => (ws.onclose = (e) => ok(e.code)));
		client.close(4001, "Disconnected");
		expect(await closed).toBe(4001);
	});

	test("refuses WebSocket upgrades without the owner's login", async () => {
		const { port } = start();
		const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
		const result = await new Promise<string>((ok) => {
			ws.onopen = () => ok("open");
			ws.onerror = () => ok("error");
		});
		expect(result).toBe("error");
	});

	test("opens the RPC socket only for a trusted peer process, told the connection's ports", async () => {
		const seen: [number, number][] = [];
		let trusted = false;
		const { port } = start({ trustPeer: async (client, serverPort) => (seen.push([client, serverPort]), trusted) });
		const attempt = () =>
			new Promise<string>((ok) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers } as never);
				ws.onopen = () => (ws.close(), ok("open"));
				ws.onerror = () => ok("error");
			});
		expect(await attempt()).toBe("error");
		trusted = true;
		expect(await attempt()).toBe("open");
		expect(seen.every(([client, serverPort]) => client > 0 && client !== port && serverPort === port)).toBe(true);
		// Static files are the public UI build and skip the process check.
		expect((await fetch(`http://127.0.0.1:${port}/`, { headers })).ok).toBe(true);
	});
});

describe("byte counts", () => {
	test("count UTF-8 bytes, not characters", () => {
		const queue = new OutboundQueue(() => {}, () => 0);
		queue.push("héllo ✓");
		expect(queue.bytesOut).toBe(Buffer.byteLength("héllo ✓"));
	});
});
