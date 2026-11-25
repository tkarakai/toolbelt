import { describe, expect, test } from "bun:test";
import { findTailscaleCli, parseServeRule, parseStatus, Tailscale, type Runner } from "../src/bun/tailscale";

const STATUS = JSON.stringify({
	BackendState: "Running",
	Self: {
		HostName: "Owner’s MacBook",
		DNSName: "mac.example-tailnet.ts.net.",
		OS: "macOS",
		TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
		UserID: 42,
		CapMap: { https: null, "funnel": null },
	},
	Peer: {
		"nodekey:a": { HostName: "iPhone", DNSName: "phone.example-tailnet.ts.net.", OS: "iOS", TailscaleIPs: ["100.64.0.2"], CurAddr: "203.0.113.5:41641", Relay: "fra" },
		"nodekey:b": { HostName: "iPad", DNSName: "ipad.example-tailnet.ts.net.", OS: "iOS", TailscaleIPs: ["100.64.0.3"], CurAddr: "", Relay: "ams" },
		"nodekey:c": { HostName: "server", OS: "linux", TailscaleIPs: ["100.64.0.4"] },
	},
	User: { "42": { LoginName: "owner@example.com" }, "7": { LoginName: "other@example.com" } },
});

describe("finding the CLI", () => {
	test("PATH comes first, then the known locations, including the app bundle", () => {
		const present = new Set(["/custom/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
		const isExecutable = (p: string) => present.has(p);
		expect(findTailscaleCli("/usr/bin:/custom/bin", isExecutable)).toBe("/custom/bin/tailscale");
		expect(findTailscaleCli("/usr/bin:/bin", isExecutable)).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
		expect(findTailscaleCli("/usr/bin", () => false)).toBeNull();
	});
});

describe("status", () => {
	test("reads the owner login, MagicDNS name, HTTPS capability and how each device is reached", () => {
		const status = parseStatus(STATUS);
		expect(status.backend).toBe("Running");
		expect(status.login).toBe("owner@example.com");
		expect(status.dnsName).toBe("mac.example-tailnet.ts.net");
		expect(status.https).toBe(true);
		expect(status.peers.get("100.64.0.1")).toEqual({ name: "mac", os: "macOS", path: "this Mac" });
		expect(status.peers.get("100.64.0.2")).toEqual({ name: "phone", os: "iOS", path: "direct" });
		expect(status.peers.get("100.64.0.3")?.path).toBe("relay ams");
		expect(status.peers.get("100.64.0.4")).toEqual({ name: "server", os: "linux", path: null });
	});

	test("missing pieces stay unknown instead of guessed", () => {
		const status = parseStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: {} }));
		expect(status).toMatchObject({ backend: "NeedsLogin", login: null, dnsName: null, https: false });
		expect(parseStatus(JSON.stringify({ Self: { Capabilities: ["https"] } })).https).toBe(true);
	});
});

describe("Serve rule", () => {
	const web = (port: number, handlers: Record<string, unknown>) => ({
		TCP: { [port]: { HTTPS: true } },
		Web: { [`mac.example-tailnet.ts.net:${port}`]: { Handlers: handlers } },
	});

	test("ours only when the whole port forwards to ToolBelt's loopback address", () => {
		expect(parseServeRule("{}", 47380)).toEqual({ state: "missing" });
		expect(parseServeRule("", 47380)).toEqual({ state: "missing" });
		expect(parseServeRule(JSON.stringify(web(47380, { "/": { Proxy: "http://127.0.0.1:47380" } })), 47380)).toEqual({ state: "ours" });
		// Another service's rule on a different port does not matter.
		expect(parseServeRule(JSON.stringify(web(11434, { "/": { Proxy: "http://localhost:11434" } })), 47380)).toEqual({ state: "missing" });
	});

	test("anything else on the port is a conflict that names its target", () => {
		expect(parseServeRule(JSON.stringify(web(47380, { "/": { Proxy: "http://127.0.0.1:3000" } })), 47380)).toEqual({ state: "conflict", target: "http://127.0.0.1:3000" });
		expect(parseServeRule(JSON.stringify(web(47380, { "/": { Proxy: "http://127.0.0.1:47380" }, "/files": { Path: "/tmp" } })), 47380)).toEqual({ state: "conflict", target: "/files → files at /tmp" });
		expect(parseServeRule(JSON.stringify({ TCP: { 47380: { TCPForward: "127.0.0.1:22" } } }), 47380)).toEqual({ state: "conflict", target: "TCP forward to 127.0.0.1:22" });
		expect(parseServeRule(JSON.stringify({ TCP: { 47380: { HTTP: true } } }), 47380)).toEqual({ state: "conflict", target: "a plain HTTP rule" });
	});
});

describe("creating and removing the rule", () => {
	function fake(serve: Record<string, unknown>) {
		const calls: string[][] = [];
		const runner: Runner = async (_cli, args) => {
			calls.push(args);
			if (args.join(" ") === "serve status --json") return { code: 0, stdout: JSON.stringify(serve), stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		return { calls, cli: new Tailscale("/fake/tailscale", runner) };
	}
	const ours = { TCP: { 47380: { HTTPS: true } }, Web: { "mac.ts.net:47380": { Handlers: { "/": { Proxy: "http://127.0.0.1:47380" } } } } };
	const theirs = { TCP: { 47380: { HTTPS: true } }, Web: { "mac.ts.net:47380": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } };

	test("creates the rule with the exact HTTPS port and loopback target", async () => {
		const { calls, cli } = fake({});
		await cli.createRule(47380);
		expect(calls.at(-1)).toEqual(["serve", "--bg", "--https=47380", "http://127.0.0.1:47380"]);
	});

	test("never overwrites another rule and never removes one that isn't ToolBelt's", async () => {
		const other = fake(theirs);
		await expect(other.cli.createRule(47380)).rejects.toThrow("already forwards to http://127.0.0.1:8080");
		await expect(other.cli.removeRule(47380)).rejects.toThrow("no longer forwards to ToolBelt");
		expect(other.calls.every((c) => c[1] === "status")).toBe(true);
	});

	test("removes its own rule; creating or removing twice is harmless", async () => {
		const own = fake(ours);
		await own.cli.createRule(47380);
		await own.cli.removeRule(47380);
		expect(own.calls.filter((c) => c[1] !== "status")).toEqual([["serve", "--https=47380", "off"]]);
		const none = fake({});
		await none.cli.removeRule(47380);
		expect(none.calls.filter((c) => c[1] !== "status")).toEqual([]);
	});

	test("CLI failures surface their message", async () => {
		const cli = new Tailscale("/fake/tailscale", async () => ({ code: 1, stdout: "", stderr: "Tailscale is stopped." }));
		await expect(cli.status()).rejects.toThrow("Tailscale is stopped.");
	});
});
