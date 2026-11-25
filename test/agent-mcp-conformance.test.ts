// MCP conformance of the agent interface (docs/agent-interface.md → Testing): what any MCP client relies
// on, checked over the real stdio shim (`toolbelt mcp`) and the socket. The MCP Inspector run at
// the end is an optional smoke check: TOOLBELT_MCP_INSPECTOR=1 (needs the network for bunx).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { MCP_VERSIONS } from "../src/bun/agent/mcp";
import { createWorld, until, type World } from "./agent-scenarios/harness";
import { CLI, McpAdapter } from "./agent-scenarios/adapters";

let world: World;
const clients: McpAdapter[] = [];
beforeAll(async () => {
	world = await createWorld();
});
afterAll(async () => {
	for (const c of clients) await c.close();
	await world.stop();
});

/** A raw JSON-RPC connection through the shim; `initialize: false` leaves the handshake to the test. */
async function rpc(initialize = true) {
	const client = new McpAdapter({ socket: world.socket, autonomous: false, client: "conformance" });
	clients.push(client);
	const c = (await client.connection(initialize))!;
	return { ...c, client };
}

describe("MCP conformance", () => {
	test("negotiates every supported version and answers others with the latest", async () => {
		for (const version of [...MCP_VERSIONS, "1999-01-01", undefined]) {
			const { request } = await rpc(false);
			const r = await request("initialize", { ...(version ? { protocolVersion: version } : {}), capabilities: {}, clientInfo: { name: "conformance", version: "1" } });
			expect(r.result.protocolVersion).toBe(version && MCP_VERSIONS.includes(version) ? version : MCP_VERSIONS[0]);
			expect(r.result.capabilities).toEqual({ tools: { listChanged: false }, resources: { subscribe: true, listChanged: true } });
			expect(r.result.serverInfo).toMatchObject({ name: "toolbelt", version: "0.3.24" });
			expect(r.result.instructions).toContain("read-only");
		}
	});

	test("tools declare valid JSON Schema inputs and annotations", async () => {
		const { request } = await rpc();
		const { tools } = (await request("tools/list")).result;
		expect(tools.length).toBeGreaterThan(0);
		const ajv = new Ajv2020({ strict: true });
		for (const tool of tools) {
			expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.inputSchema.type).toBe("object");
			// Compiling checks the schema against the 2020-12 meta-schema (MCP's default dialect),
			// and strict mode refuses unknown keywords.
			const validate = ajv.compile(tool.inputSchema);
			expect(validate({ unexpected: true })).toBe(tool.inputSchema.additionalProperties !== false);
			expect(tool.annotations).toEqual({ title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
		}
		const read = ajv.compile(tools.find((t: { name: string }) => t.name === "read_screen").inputSchema);
		expect(read({ plugin: "desk", screen: "tasks", format: "json", max_rows: 3, table: "tasks", offset: 0, details: false })).toBe(true);
		expect(read({ screen: "tasks" })).toBe(false);
		expect(read({ plugin: "desk", format: "xml" })).toBe(false);
	});

	test("JSON-RPC errors: unknown method, unknown tool, invalid request; notifications get no reply", async () => {
		const { request, send, client } = await rpc();
		expect((await request("nope/never")).error.code).toBe(-32601);
		expect((await request("tools/call", { name: "delete_everything", arguments: {} })).error.code).toBe(-32602);
		const before = client.lines.length;
		send({ jsonrpc: "2.0", method: "notifications/whatever" });
		send({ jsonrpc: "2.0", id: 999 });
		expect((await request("ping")).result).toEqual({});
		const replies = client.lines.slice(before).map((l) => JSON.parse(l));
		expect(replies.find((m) => m.id === 999).error.code).toBe(-32600);
		expect(replies.filter((m) => m.id === undefined)).toEqual([]);
	});

	test("refusals are isError tool results, not JSON-RPC errors", async () => {
		const { request } = await rpc();
		for (const args of [{ plugin: "vault" }, { plugin: "nope" }, { plugin: "desk", screen: "nope" }]) {
			const r = await request("tools/call", { name: "read_screen", arguments: args });
			expect(r.error).toBeUndefined();
			expect(r.result.isError).toBe(true);
			expect(r.result.content[0].type).toBe("text");
			expect(r.result.structuredContent).toBeUndefined();
		}
		const ok = await request("tools/call", { name: "toolbelt_status", arguments: {} });
		expect(ok.result.isError).toBeUndefined();
		expect(ok.result.structuredContent.hiddenPlugins).toBe(2); // vault opts out; jot declares nothing
	});

	test("answers requests on a connection in order", async () => {
		const { request } = await rpc();
		const order: string[] = [];
		await Promise.all([
			request("tools/call", { name: "search_screens", arguments: { query: "job" } }).then(() => order.push("search")),
			request("ping").then(() => order.push("ping")),
		]);
		expect(order).toEqual(["search", "ping"]);
	});

	test("a connection without a valid hello line is closed without a session", async () => {
		for (const first of [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { toolbelt: 2 }, "not json"]) {
			const lines: string[] = [];
			let closed = false;
			const socket = await Bun.connect({
				unix: world.socket,
				socket: { data: (_s, chunk) => void lines.push(new TextDecoder().decode(chunk)), close: () => void (closed = true) },
			});
			socket.write((typeof first === "string" ? first : JSON.stringify(first)) + "\n");
			socket.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
			await until(() => closed, 2000, "the server to close the connection");
			// Nothing is answered; a line that isn't JSON gets JSON-RPC's parse error first.
			const replies = lines.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
			expect(replies).toEqual(typeof first === "string" ? [{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }] : []);
		}
		expect(world.agents.core.state().sessions.some((s) => s.client === "agent")).toBe(false);
	});

	test("resources: list, read, templates and subscribe", async () => {
		const { request, client } = await rpc();
		const { resources } = (await request("resources/list")).result;
		// Plugins come in the order the host found them (a directory listing, which differs by
		// file system); each plugin's screens keep their manifest order.
		const uris: string[] = resources.map((r: { uri: string }) => r.uri);
		const of = (plugin: string) => uris.filter((u) => u.startsWith(`toolbelt://screens/${plugin}/`));
		expect(of("desk")).toEqual(["toolbelt://screens/desk/tasks", "toolbelt://screens/desk/settings"]);
		expect(of("kit")).toEqual(["toolbelt://screens/kit/updates", "toolbelt://screens/kit/activity", "toolbelt://screens/kit/connection", "toolbelt://screens/kit/queue"]);
		expect(uris).toHaveLength(6);
		expect(resources.every((r: { mimeType: string; name: string }) => r.mimeType === "text/markdown" && r.name)).toBe(true);
		expect((await request("resources/templates/list")).result).toEqual({ resourceTemplates: [] });
		const read = (await request("resources/read", { uri: "toolbelt://screens/desk/settings" })).result;
		expect(read.contents).toEqual([{ uri: "toolbelt://screens/desk/settings", mimeType: "text/markdown", text: expect.stringContaining("Mark stalled tasks: on") }]);
		expect((await request("resources/read", { uri: "toolbelt://screens/vault/processes" })).error.code).toBe(-32002);
		expect((await request("resources/subscribe", { uri: "toolbelt://screens/vault/processes" })).error.code).toBe(-32002);
		expect((await request("resources/read", { uri: "https://example.test" })).error.code).toBe(-32002);

		const uri = "toolbelt://screens/desk/tasks";
		expect((await request("resources/subscribe", { uri })).result).toEqual({});
		const seen = client.notifications().length;
		await world.person({ event: { screen: "desk/tasks", name: "settle", payload: { rowId: "7" } } });
		await until(() => client.notifications().slice(seen).find((n) => n.method === "notifications/resources/updated" && n.params.uri === uri), 2500, "an update");
		expect((await request("resources/unsubscribe", { uri })).result).toEqual({});
		const after = client.notifications().length;
		await world.person({ event: { screen: "desk/tasks", name: "reopen", payload: { rowId: "7" } } });
		await Bun.sleep(1300);
		expect(client.notifications().slice(after).filter((n) => n.method === "notifications/resources/updated")).toEqual([]);

		const changed = client.notifications().length;
		await world.person({ access: { plugin: "kit", level: "none" } });
		await until(() => client.notifications().slice(changed).some((n) => n.method === "notifications/resources/list_changed"), 1000, "list_changed");
		expect((await request("resources/list")).result.resources.some((r: { uri: string }) => r.uri.includes("/kit/"))).toBe(false);
		await world.person({ access: { plugin: "kit", level: null } });
	});

	test.skipIf(!process.env.TOOLBELT_MCP_INSPECTOR)("MCP Inspector CLI lists and calls tools (optional smoke check)", { timeout: 120_000 }, async () => {
		const inspector = async (...args: string[]) => {
			const p = Bun.spawn(["bunx", "@modelcontextprotocol/inspector@0.17.2", "--cli", process.execPath, CLI, "--socket", world.socket, "mcp", ...args], { stdout: "pipe", stderr: "pipe" });
			const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
			expect(code).toBe(0);
			return JSON.parse(out);
		};
		expect((await inspector("--method", "tools/list")).tools.map((t: { name: string }) => t.name)).toContain("read_screen");
		const status = await inspector("--method", "tools/call", "--tool-name", "toolbelt_status");
		expect(status.content[0].text).toContain("Desk (desk)");
		expect((await inspector("--method", "resources/list")).resources.length).toBe(6);
	});
});
