import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAccess } from "../src/bun/remote-access";
import type { Runner } from "../src/bun/tailscale";
import { badgeTotal, REMOTE_CLOSE, type RemoteSettings } from "../src/shared/remote";

const root = mkdtempSync(join(tmpdir(), "toolbelt-remote-access-"));
writeFileSync(join(root, "index.html"), "<p>shell</p>");

/** A fake Tailscale: status for the owner, a Serve config it keeps in memory. */
function fakeTailscale() {
	const rules = new Map<number, string>();
	const calls: string[] = [];
	const runner: Runner = async (_cli, args) => {
		calls.push(args.join(" "));
		if (args[0] === "status")
			return {
				code: 0,
				stderr: "",
				stdout: JSON.stringify({
					BackendState: "Running",
					Self: { DNSName: "mac.example.ts.net.", UserID: 1, CapMap: { https: null }, TailscaleIPs: ["100.64.0.1"] },
					Peer: { a: { DNSName: "phone.example.ts.net.", OS: "iOS", TailscaleIPs: ["100.64.0.2"], CurAddr: "1.2.3.4:5" } },
					User: { "1": { LoginName: "owner@example.com" } },
				}),
			};
		if (args.join(" ") === "serve status --json") {
			const TCP: Record<string, unknown> = {};
			const Web: Record<string, unknown> = {};
			for (const [port, target] of rules) {
				TCP[port] = { HTTPS: true };
				Web[`mac.example.ts.net:${port}`] = { Handlers: { "/": { Proxy: target } } };
			}
			return { code: 0, stderr: "", stdout: JSON.stringify({ TCP, Web }) };
		}
		const https = args.find((a) => a.startsWith("--https="));
		const port = Number(https?.slice(8));
		if (args.at(-1) === "off") rules.delete(port);
		else rules.set(port, args.at(-1)!);
		return { code: 0, stdout: "", stderr: "" };
	};
	return { rules, calls, runner };
}

let access: RemoteAccess | null = null;
afterEach(async () => {
	await access?.stop();
	access = null;
});

function make(options: { cli?: string | null; settings?: Partial<RemoteSettings> } = {}) {
	const tailscale = fakeTailscale();
	let settings: RemoteSettings = { enabled: false, port: 0, badgePlugins: [], ...options.settings };
	const states: unknown[] = [];
	access = new RemoteAccess({
		settings: () => settings,
		save: (next) => (settings = next),
		root,
		devicesFile: join(mkdtempSync(join(tmpdir(), "toolbelt-devices-")), "remote-devices.json"),
		handlers: { request: () => null },
		changed: (state) => states.push(state),
		findCli: () => (options.cli === undefined ? "/fake/tailscale" : options.cli),
		runner: tailscale.runner,
		// The ts.net address can't resolve in tests: answer for the server directly.
		fetch: async () => Response.json({ instance: access!.instance }),
		refreshMs: 60_000,
		// The peer-owner check reads macOS's netstat (test/peer-owner.test.ts covers it).
		trustPeer: async () => true,
	});
	return { access, tailscale, settings: () => settings, states };
}

/** A WebSocket from the phone (100.64.0.2) that pairs with the code the Mac shows. */
async function pairedSocket(port: number, access: RemoteAccess, label = "Safari") {
	const state = await access.handle({ operation: "startPairing" });
	const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
		headers: { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.2" },
	} as never);
	const messages: { kind: string; token?: string; device?: { id: string; name: string } }[] = [];
	ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
	await new Promise((ok) => (ws.onopen = ok));
	ws.send(JSON.stringify({ kind: "pair", secret: state.pairing!.code, label }));
	for (let i = 0; i < 100 && !messages.some((m) => m.kind === "paired"); i++) await Bun.sleep(10);
	const paired = messages.find((m) => m.kind === "paired")!;
	return { ws, token: paired.token!, device: paired.device!, messages };
}

describe("remote access", () => {
	test("reads Tailscale, creates and removes only its own rule", async () => {
		const { access, tailscale } = make({ settings: { port: 47999 } });
		let state = await access.handle({ operation: "read" });
		expect(state.tailscale).toMatchObject({ cli: "/fake/tailscale", login: "owner@example.com", dnsName: "mac.example.ts.net", https: true });
		expect(state.rule).toEqual({ state: "missing" });
		expect(state.url).toBe("https://mac.example.ts.net:47999/");
		state = await access.handle({ operation: "createRule" });
		expect(tailscale.rules.get(47999)).toBe("http://127.0.0.1:47999");
		expect(state.rule).toEqual({ state: "ours" });
		state = await access.handle({ operation: "removeRule" });
		expect(tailscale.rules.has(47999)).toBe(false);
		tailscale.rules.set(47999, "http://127.0.0.1:3000");
		state = await access.handle({ operation: "removeRule" });
		expect(state.lastError).toContain("no longer forwards to ToolBelt");
		expect(tailscale.rules.get(47999)).toBe("http://127.0.0.1:3000");
	});

	test("without a CLI everything Tailscale-dependent reports why", async () => {
		const { access } = make({ cli: null });
		const state = await access.handle({ operation: "createRule" });
		expect(state.tailscale.cliError).toContain("not found");
		expect(state.lastError).toContain("not found");
	});

	test("turning on serves and probes reachability; turning off closes connections and frees the port", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access, tailscale } = make({ settings: { port } });
		tailscale.rules.set(port, `http://127.0.0.1:${port}`);
		let state = await access.handle({ operation: "setEnabled", enabled: true });
		expect(state.running).toBe(true);
		expect(state.reachable).toBe("yes");
		const { ws } = await pairedSocket(port, access);
		await Bun.sleep(20);
		state = access.state();
		expect(state.paired).toMatchObject([
			{ name: "phone (Safari)", live: { ip: "100.64.0.2", tailscaleName: "phone", os: "iOS", path: "direct", connections: 1 } },
		]);
		const closed = new Promise<number>((ok) => (ws.onclose = (e) => ok(e.code)));
		state = await access.handle({ operation: "setEnabled", enabled: false });
		expect(await closed).toBe(REMOTE_CLOSE.off);
		expect(state.running).toBe(false);
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	});

	test("disconnect closes only that paired device's connections, which stays paired", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		// The same phone (one tailnet IP) as a browser and as its home-screen app.
		const browser = await pairedSocket(port, access, "Safari");
		const app = await pairedSocket(port, access, "Home Screen app");
		const closed = new Promise<number>((ok) => (browser.ws.onclose = (e) => ok(e.code)));
		await access.handle({ operation: "disconnect", id: browser.device.id });
		expect(await closed).toBe(REMOTE_CLOSE.disconnected);
		await Bun.sleep(20);
		expect(app.ws.readyState).toBe(WebSocket.OPEN);
		const state = access.state();
		expect(state.paired.map((d) => [d.name, !!d.live])).toEqual([
			["phone (Home Screen app)", true],
			["phone (Safari)", false],
		]);
	});

	test("a device's last use moves to when its connection ends", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		const { ws } = await pairedSocket(port, access);
		const pairedAt = access.state().paired[0]!.lastSeen;
		await Bun.sleep(15);
		ws.close();
		await Bun.sleep(30);
		const [device] = access.state().paired;
		expect(device!.live).toBeNull();
		expect(device!.lastSeen).toBeGreaterThan(pairedAt);
	});

	test("moving the port moves ToolBelt's rule", async () => {
		const { access, tailscale, settings } = make({ settings: { port: 47001 } });
		await access.handle({ operation: "createRule" });
		await access.handle({ operation: "setPort", port: 47002, moveRule: true });
		expect(settings().port).toBe(47002);
		expect([...tailscale.rules.keys()]).toEqual([47002]);
		const state = await access.handle({ operation: "setPort", port: 80 });
		expect(state.lastError).toContain("between 1024 and 65535");
	});

	test("turning on twice keeps one server, and turning off frees the port", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		const state = await access.handle({ operation: "setEnabled", enabled: true });
		expect(state.running).toBe(true);
		expect(state.serverError).toBeNull();
		await access.handle({ operation: "setEnabled", enabled: false });
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	});

	test("on and off in quick succession end up off, with nothing listening", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access, settings } = make({ settings: { port } });
		const on = access.handle({ operation: "setEnabled", enabled: true });
		const off = access.handle({ operation: "setEnabled", enabled: false });
		await Promise.all([on, off]);
		expect(settings().enabled).toBe(false);
		expect(access.state().running).toBe(false);
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	});

	test("a port in use is refused before ToolBelt's rule or server moves", async () => {
		const port = 40000 + Math.floor(Math.random() * 10000);
		const taken = Bun.listen({ hostname: "127.0.0.1", port: port + 10000, socket: { data() {} } });
		try {
			const { access, tailscale, settings } = make({ settings: { port } });
			await access.handle({ operation: "setEnabled", enabled: true });
			await access.handle({ operation: "createRule" });
			const state = await access.handle({ operation: "setPort", port: port + 10000, moveRule: true });
			expect(state.lastError).toContain("already in use");
			expect(settings().port).toBe(port);
			expect([...tailscale.rules.keys()]).toEqual([port]);
			expect(state.running).toBe(true);
			expect((await fetch(`http://127.0.0.1:${port}/.well-known/toolbelt`)).ok).toBe(true);
		} finally {
			taken.stop(true);
		}
	});

	test("moving a running server keeps serving on the new port", async () => {
		const port = 40000 + Math.floor(Math.random() * 10000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		const state = await access.handle({ operation: "setPort", port: port + 10000 });
		expect(state.running).toBe(true);
		expect((await fetch(`http://127.0.0.1:${port + 10000}/.well-known/toolbelt`)).ok).toBe(true);
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	});

	test("pairing names the device after Tailscale and lists it as connected", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access, states } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		const { device, token } = await pairedSocket(port, access, "Home Screen app");
		expect(device.name).toBe("phone (Home Screen app)");
		expect(token.length).toBeGreaterThan(40);
		await Bun.sleep(20);
		const state = access.state();
		expect(state.paired).toMatchObject([{ id: device.id, name: "phone (Home Screen app)", live: { connections: 1 } }]);
		expect(state.pairing?.paired).toEqual(["phone (Home Screen app)"]);
		// The Mac's dialog heard about it.
		expect(states.some((s) => (s as typeof state).pairing?.paired.length === 1)).toBe(true);
	});

	test("a paired device's token opens later connections; an unknown one stays unpaired", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		const first = await pairedSocket(port, access);
		first.ws.close();
		await access.handle({ operation: "stopPairing" });
		const hello = async (token: string) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, { headers: { "tailscale-user-login": "owner@example.com" } } as never);
			const reply = new Promise<string>((ok) => (ws.onmessage = (e) => ok(JSON.parse(String(e.data)).kind)));
			await new Promise((ok) => (ws.onopen = ok));
			ws.send(JSON.stringify({ kind: "hello", token }));
			const kind = await reply;
			ws.close();
			return kind;
		};
		expect(await hello(first.token)).toBe("paired");
		expect(await hello("x".repeat(43))).toBe("unpaired");
	});

	test("removing a device closes its connections with the revoked code and forgets its token", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		const { ws, device, token } = await pairedSocket(port, access);
		const closed = new Promise<number>((ok) => (ws.onclose = (e) => ok(e.code)));
		const state = await access.handle({ operation: "revoke", id: device.id });
		expect(await closed).toBe(REMOTE_CLOSE.revoked);
		expect(state.paired).toEqual([]);
		expect(access.registry.verify(token)).toBeNull();
		expect((await access.handle({ operation: "revoke", id: device.id })).lastError).toContain("isn’t paired");
	});

	test("turning remote access off ends the pairing in progress", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		expect((await access.handle({ operation: "startPairing" })).pairing?.code).toMatch(/^\d{6}$/);
		expect((await access.handle({ operation: "setEnabled", enabled: false })).pairing).toBeNull();
	});

	test("badge plugins are saved without duplicates", async () => {
		const { access, settings } = make();
		await access.handle({ operation: "setBadgePlugins", plugins: ["a", "b", "a", 3 as never] });
		expect(settings().badgePlugins).toEqual(["a", "b"]);
	});
});

describe("badge total", () => {
	const p = (id: string, badge: number | string | null) => ({ manifest: { id }, badge });
	test("adds numeric badges of the chosen plugins only", () => {
		expect(badgeTotal([p("a", 2), p("b", "3"), p("c", 10)], ["a", "b"])).toBe(5);
	});
	test("text badges alone show a dot; nothing chosen or zero clears it", () => {
		expect(badgeTotal([p("a", "!"), p("b", 0)], ["a", "b"])).toBe("dot");
		expect(badgeTotal([p("a", 4), p("b", "new")], ["a", "b"])).toBe(4);
		expect(badgeTotal([p("a", 0), p("b", null)], ["a", "b"])).toBeNull();
		expect(badgeTotal([p("a", 3)], [])).toBeNull();
	});
});

describe("saved remote settings", () => {
	test("malformed fields fall back to their defaults", async () => {
		const { remoteSettings } = await import("../src/bun/settings");
		const defaults: RemoteSettings = { enabled: false, port: 47380, badgePlugins: [] };
		expect(remoteSettings(undefined, defaults)).toEqual(defaults);
		expect(remoteSettings({ enabled: "yes", port: 80, badgePlugins: "a" }, defaults)).toEqual(defaults);
		expect(remoteSettings({ enabled: true, port: 47390, badgePlugins: ["a", 1, "a"] }, defaults)).toEqual({
			enabled: true,
			port: 47390,
			badgePlugins: ["a"],
		});
	});
});
