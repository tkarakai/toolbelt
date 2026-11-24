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
		handlers: { request: () => null },
		changed: (state) => states.push(state),
		findCli: () => (options.cli === undefined ? "/fake/tailscale" : options.cli),
		runner: tailscale.runner,
		// The ts.net address can't resolve in tests: answer for the server directly.
		fetch: async () => Response.json({ instance: access!.instance }),
		refreshMs: 60_000,
	});
	return { access, tailscale, settings: () => settings, states };
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
		const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
			headers: { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.2" },
		} as never);
		await new Promise((ok) => (ws.onopen = ok));
		await Bun.sleep(20);
		state = access.state();
		expect(state.devices).toMatchObject([{ ip: "100.64.0.2", name: "phone", os: "iOS", path: "direct", connections: 1 }]);
		const closed = new Promise<number>((ok) => (ws.onclose = (e) => ok(e.code)));
		state = await access.handle({ operation: "setEnabled", enabled: false });
		expect(await closed).toBe(REMOTE_CLOSE.off);
		expect(state.running).toBe(false);
		await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
	});

	test("disconnect closes that device's connections with the stop-reconnecting code", async () => {
		const port = 40000 + Math.floor(Math.random() * 20000);
		const { access } = make({ settings: { port } });
		await access.handle({ operation: "setEnabled", enabled: true });
		const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
			headers: { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.2" },
		} as never);
		await new Promise((ok) => (ws.onopen = ok));
		const closed = new Promise<number>((ok) => (ws.onclose = (e) => ok(e.code)));
		await access.handle({ operation: "disconnect", ip: "100.64.0.2" });
		expect(await closed).toBe(REMOTE_CLOSE.disconnected);
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
