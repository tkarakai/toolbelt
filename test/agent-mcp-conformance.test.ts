// MCP conformance of the agent interface (docs/agent-interface.md → Testing): what any MCP client relies
// on, checked over the real stdio shim (`toolbelt mcp`) and the socket. The MCP Inspector run at
// the end is an optional smoke check: TOOLBELT_MCP_INSPECTOR=1 (needs the network for bunx).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { MCP_VERSIONS, MODERN_VERSIONS } from "../src/bun/agent/mcp";
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
			// show_screen changes only what the person's screens show; run_action and fill_form act.
			if (tool.name === "run_action") expect(tool.annotations).toEqual({ title: tool.title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
			else if (tool.name === "fill_form") expect(tool.annotations).toEqual({ title: tool.title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
			else expect(tool.annotations).toEqual({ title: tool.title, readOnlyHint: tool.name !== "show_screen", destructiveHint: false, idempotentHint: true, openWorldHint: false });
		}
		const read = ajv.compile(tools.find((t: { name: string }) => t.name === "read_screen").inputSchema);
		expect(read({ plugin: "desk", screen: "tasks", format: "json", max_rows: 3, table: "tasks", offset: 0, details: false })).toBe(true);
		expect(read({ screen: "tasks" })).toBe(false);
		expect(read({ plugin: "desk", format: "xml" })).toBe(false);
		expect(read({ plugin: "desk", view: { search: "x", filters: { status: ["done"] }, sort: { tasks: "-title" }, controls: { mode: "list" } } })).toBe(true);
		expect(read({ plugin: "desk", view: "person" })).toBe(true);
		expect(read({ plugin: "desk", view: "mine" })).toBe(false);
		expect(read({ plugin: "desk", view: { colour: "red" } })).toBe(false);
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
		const ok = await request("tools/call", { name: "toolbelt_status", arguments: { format: "json" } });
		expect(ok.result.isError).toBeUndefined();
		expect(ok.result.structuredContent.hiddenPlugins).toBe(1); // vault opts out
	});

	test("text and structured content carry the same information", async () => {
		// Clients may show either: Claude Code shows structuredContent when present. So a text result
		// has none, and a JSON result's text is its structuredContent serialized (as MCP recommends).
		const { request } = await rpc();
		const calls: [string, Record<string, unknown>][] = [
			["toolbelt_status", {}],
			["list_screens", {}],
			["list_screens", { plugin: "desk" }],
			["read_screen", { plugin: "desk", screen: "tasks" }],
			["read_screen", { plugin: "kit", screen: "updates", max_rows: 2, details: false }],
			["search_screens", { query: "job" }],
			["list_plugins", {}],
		];
		for (const [name, args] of calls) {
			const text = (await request("tools/call", { name, arguments: args })).result;
			expect(text.isError).toBeUndefined();
			expect(text.structuredContent).toBeUndefined();
			expect(text.content).toHaveLength(1);
			const json = (await request("tools/call", { name, arguments: { ...args, format: "json" } })).result;
			expect(json.structuredContent).toBeObject();
			expect(JSON.parse(json.content[0].text)).toEqual(json.structuredContent);
		}
		// The facts a text read gives are in the JSON read too.
		const text = (await request("tools/call", { name: "read_screen", arguments: { plugin: "desk", screen: "tasks" } })).result.content[0].text;
		const json = (await request("tools/call", { name: "read_screen", arguments: { plugin: "desk", screen: "tasks", format: "json" } })).result.structuredContent;
		expect(text).toContain("Q4 budget review with finance");
		expect(JSON.stringify(json.tree)).toContain("Q4 budget review with finance");
		expect(json).toMatchObject({ plugin: "desk", screen: "tasks", rendered: true, renderedAtIso: expect.any(String), personViewing: expect.any(Boolean), viewState: expect.any(Array) });
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
		const { resourceTemplates } = (await request("resources/templates/list")).result;
		expect(resourceTemplates).toEqual([expect.objectContaining({ uriTemplate: "toolbelt://screens/{plugin}/{screen}{?table,parent,offset,max_rows,details,view,search}", name: "screen", mimeType: "text/markdown" })]);
		// A paged resource read is read_screen with the same paging.
		const paged = (await request("resources/read", { uri: "toolbelt://screens/kit/queue?table=jobs&offset=247&max_rows=2&details=false" })).result.contents[0];
		expect(paged.uri).toBe("toolbelt://screens/kit/queue?table=jobs&offset=247&max_rows=2&details=false");
		expect(paged.text).toContain("Job 248");
		expect(paged.text).toContain("(showing rows 248–249 of 250");
		expect(paged.text).not.toContain("Job 247 ");
		// Its hints name the next URI to read, not read_screen options.
		const first = (await request("resources/read", { uri: "toolbelt://screens/kit/queue?table=jobs&max_rows=3" })).result.contents[0].text;
		expect(first).toContain("read toolbelt://screens/kit/queue?table=jobs&offset=3 for more");
		expect(first).not.toContain("read again with table");
		for (const bad of ["offset=x", "colour=red", "details=maybe", "view=mine", "filter.nope=x"])
			expect((await request("resources/read", { uri: `toolbelt://screens/kit/queue?${bad}` })).error.code).toBe(-32602);
		// A view in the URI: the agent's own, searched and filtered; paging hints keep it.
		const viewed = (await request("resources/read", { uri: "toolbelt://screens/desk/tasks?filter.status=&search=passport" })).result.contents[0].text;
		expect(viewed).toContain('Your view: search "passport"; Status: all.');
		expect(viewed).toContain("Renew passport");
		expect((await request("resources/read", { uri: "toolbelt://screens/desk/tasks?view=person" })).result.contents[0].text).toContain("The person's view");
		expect((await request("resources/read", { uri: "toolbelt://screens/desk/tasks?filter.status=nope" })).error.code).toBe(-32602);
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
		await world.person({ event: { screen: "desk/tasks", name: "reopen-all" } });
		await Bun.sleep(1300);
		expect(client.notifications().slice(after).filter((n) => n.method === "notifications/resources/updated")).toEqual([]);

		// A subscription to a view watches that view's instance.
		const viewUri = "toolbelt://screens/desk/tasks?filter.status=done";
		expect((await request("resources/subscribe", { uri: viewUri })).result).toEqual({});
		expect((await request("resources/subscribe", { uri: "toolbelt://screens/desk/tasks?filter.nope=x" })).error.code).toBe(-32602);
		const beforeView = client.notifications().length;
		await world.person({ event: { screen: "desk/tasks", name: "settle", payload: { rowId: "5" } } });
		await until(() => client.notifications().slice(beforeView).find((n) => n.method === "notifications/resources/updated" && n.params.uri === viewUri), 2500, "an update of the view");
		expect((await request("resources/unsubscribe", { uri: viewUri })).result).toEqual({});

		const changed = client.notifications().length;
		await world.person({ access: { plugin: "kit", level: "none" } });
		await until(() => client.notifications().slice(changed).some((n) => n.method === "notifications/resources/list_changed"), 1000, "list_changed");
		expect((await request("resources/list")).result.resources.some((r: { uri: string }) => r.uri.includes("/kit/"))).toBe(false);
		await world.person({ access: { plugin: "kit", level: null } });
	});

	test("the stdio shim survives ToolBelt going away and continues the client's session", { timeout: 20_000 }, async () => {
		const { request, client } = await rpc();
		const uri = "toolbelt://screens/desk/tasks";
		expect((await request("resources/subscribe", { uri })).result).toEqual({});
		await world.person({ agents: false });
		// The shim stays up and answers for ToolBelt, so the client doesn't mark the server failed.
		const down = await request("tools/call", { name: "toolbelt_status", arguments: {} });
		expect(down.error).toMatchObject({ code: -32000, data: { reason: "unreachable" } });
		expect(down.error.message).toContain("ToolBelt isn't reachable right now");
		expect((await request("ping")).error.data.reason).toBe("unreachable");
		const before = client.notifications().length;
		await world.person({ agents: true });
		// The next request reconnects; the client never initializes again.
		const up = await request("tools/call", { name: "toolbelt_status", arguments: {} });
		expect(up.result.content[0].text).toContain("Desk (desk)");
		// The replayed initialize named the new session after the client, and its reply wasn't passed on.
		expect(world.agents.core.state().sessions.some((s) => s.client === "conformance")).toBe(true);
		expect(client.lines.some((l) => l.includes("toolbelt-shim-"))).toBe(false);
		await until(() => client.notifications().slice(before).some((n) => n.method === "notifications/resources/list_changed"), 2000, "list_changed after reconnecting");
		// The subscription was restored on the new session.
		const seen = client.notifications().length;
		await world.person({ event: { screen: "desk/tasks", name: "settle", payload: { rowId: "7" } } });
		await until(() => client.notifications().slice(seen).some((n) => n.method === "notifications/resources/updated" && n.params.uri === uri), 3000, "an update after reconnecting");
		await world.person({ event: { screen: "desk/tasks", name: "reopen-all" } });
		expect((await request("resources/unsubscribe", { uri })).result).toEqual({});
	});

	// MCP 2026-07-28: requests name their version in _meta, with no handshake.
	const META = (version = "2026-07-28", extra: Record<string, unknown> = {}) => ({
		"io.modelcontextprotocol/protocolVersion": version,
		"io.modelcontextprotocol/clientInfo": { name: "modern-conformance", version: "1" },
		"io.modelcontextprotocol/clientCapabilities": {},
		...extra,
	});
	const SUB = "io.modelcontextprotocol/subscriptionId";

	test("modern: server/discover, version and _meta checks, removed methods", async () => {
		const { request } = await rpc(false);
		const d = (await request("server/discover", { _meta: META() })).result;
		expect(d).toMatchObject({
			resultType: "complete",
			supportedVersions: [...MODERN_VERSIONS, ...MCP_VERSIONS],
			capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true } },
			ttlMs: expect.any(Number),
			cacheScope: "private",
		});
		expect(d._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: "toolbelt" });
		expect(d.instructions).toContain("read_screen");
		// A legacy client probing without _meta gets an error and falls back to initialize.
		expect((await request("server/discover", {})).error.code).toBe(-32602);
		const old = (await request("tools/list", { _meta: META("1999-01-01") })).error;
		expect(old.code).toBe(-32022);
		expect(old.data).toEqual({ supported: [...MODERN_VERSIONS, ...MCP_VERSIONS], requested: "1999-01-01" });
		const noCaps = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
		expect((await request("tools/list", { _meta: noCaps })).error.code).toBe(-32602);
		expect((await request("ping", { _meta: META() })).error.code).toBe(-32601);
		expect((await request("resources/subscribe", { uri: "toolbelt://screens/desk/tasks", _meta: META() })).error.code).toBe(-32601);
	});

	test("modern: tools and resources without a handshake carry resultType, identity and cache hints", async () => {
		const { request } = await rpc(false);
		const list = (await request("tools/list", { _meta: META() })).result;
		expect(list).toMatchObject({ resultType: "complete", ttlMs: 3_600_000, cacheScope: "public" });
		expect(list.tools.map((t: { name: string }) => t.name)).toContain("read_screen");
		const call = (await request("tools/call", { name: "toolbelt_status", arguments: {}, _meta: META() })).result;
		expect(call.resultType).toBe("complete");
		expect(call.content[0].text).toContain("Desk (desk)");
		expect(call._meta["io.modelcontextprotocol/serverInfo"].name).toBe("toolbelt");
		// Tool results aren't cacheable.
		expect(call.ttlMs).toBeUndefined();
		// The first request's clientInfo named the session.
		expect(world.agents.core.state().sessions.some((s) => s.client === "modern-conformance")).toBe(true);
		const resources = (await request("resources/list", { _meta: META() })).result;
		expect(resources).toMatchObject({ resultType: "complete", cacheScope: "private", ttlMs: expect.any(Number) });
		expect((await request("resources/templates/list", { _meta: META() })).result).toMatchObject({ resultType: "complete", cacheScope: "public" });
		const read = (await request("resources/read", { uri: "toolbelt://screens/desk/settings", _meta: META() })).result;
		expect(read).toMatchObject({ resultType: "complete", cacheScope: "private", ttlMs: 1_000 });
		expect(read.contents[0].text).toContain("Mark stalled tasks: on");
		// Resource not found is Invalid Params since 2026-07-28; legacy requests keep -32002.
		expect((await request("resources/read", { uri: "toolbelt://screens/vault/processes", _meta: META() })).error.code).toBe(-32602);
		expect((await request("resources/read", { uri: "toolbelt://screens/vault/processes" })).error.code).toBe(-32002);
		expect((await request("prompts/list", { _meta: META() })).result).toMatchObject({ resultType: "complete", prompts: [] });
	});

	test("modern: subscriptions/listen acknowledges, tags notifications and ends on cancel", async () => {
		const { request, send, client } = await rpc(false);
		const uri = "toolbelt://screens/desk/tasks";
		const before = client.notifications().length;
		send({ jsonrpc: "2.0", id: "listen-1", method: "subscriptions/listen", params: { _meta: META(), notifications: { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: [uri, "toolbelt://screens/vault/processes"] } } });
		const ack = await until(() => client.notifications().slice(before).find((n) => n.method === "notifications/subscriptions/acknowledged"), 2000, "the acknowledgment");
		expect(ack.params._meta[SUB]).toBe("listen-1");
		// Only what ToolBelt honors: the tool list never changes, and a hidden screen isn't watched.
		expect(ack.params.notifications).toEqual({ resourcesListChanged: true, resourceSubscriptions: [uri] });
		// Other requests go on while the stream is open; the stream itself gets no response.
		expect((await request("tools/list", { _meta: META() })).result.resultType).toBe("complete");
		expect(client.lines.some((l) => JSON.parse(l).id === "listen-1" && !("method" in JSON.parse(l)))).toBe(false);
		const seen = client.notifications().length;
		await world.person({ event: { screen: "desk/tasks", name: "settle", payload: { rowId: "7" } } });
		const update = await until(() => client.notifications().slice(seen).find((n) => n.method === "notifications/resources/updated"), 2500, "a tagged update");
		expect(update.params).toEqual({ uri, _meta: { [SUB]: "listen-1" } });
		const changed = client.notifications().length;
		await world.person({ access: { plugin: "kit", level: "none" } });
		const list = await until(() => client.notifications().slice(changed).find((n) => n.method === "notifications/resources/list_changed"), 1000, "a tagged list_changed");
		expect(list.params._meta[SUB]).toBe("listen-1");
		await world.person({ access: { plugin: "kit", level: null } });
		// Cancelling the stream (stdio) stops its notifications.
		send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "listen-1" } });
		await request("tools/list", { _meta: META() });
		const after = client.notifications().length;
		await world.person({ event: { screen: "desk/tasks", name: "reopen-all" } });
		await Bun.sleep(1300);
		expect(client.notifications().slice(after).filter((n) => n.method === "notifications/resources/updated")).toEqual([]);
	});

	test("both eras on one connection", async () => {
		const { request } = await rpc(true);
		expect((await request("tools/list")).result.resultType).toBeUndefined();
		expect((await request("tools/list", { _meta: META() })).result.resultType).toBe("complete");
		expect((await request("ping")).result).toEqual({});
	});

	test("the stdio shim reopens a modern client's streams after ToolBelt goes away", { timeout: 20_000 }, async () => {
		const { request, send, client } = await rpc(false);
		const uri = "toolbelt://screens/desk/tasks";
		const start = client.notifications().length;
		send({ jsonrpc: "2.0", id: 41, method: "subscriptions/listen", params: { _meta: META(), notifications: { resourcesListChanged: true, resourceSubscriptions: [uri] } } });
		await until(() => client.notifications().slice(start).find((n) => n.method === "notifications/subscriptions/acknowledged"), 2000, "the acknowledgment");
		await world.person({ agents: false });
		const down = await request("tools/call", { name: "toolbelt_status", arguments: {}, _meta: META() });
		expect(down.error.data.reason).toBe("unreachable");
		const before = client.notifications().length;
		await world.person({ agents: true });
		const up = await request("tools/call", { name: "toolbelt_status", arguments: {}, _meta: META() });
		expect(up.result.content[0].text).toContain("Desk (desk)");
		// The stream was told things may have changed, without a second acknowledgment or its end.
		await until(() => client.notifications().slice(before).some((n) => n.method === "notifications/resources/list_changed" && n.params?._meta?.[SUB] === 41), 2000, "list_changed after reconnecting");
		expect(client.notifications().slice(before).some((n) => n.method === "notifications/resources/updated" && n.params.uri === uri && n.params._meta[SUB] === 41)).toBe(true);
		expect(client.notifications().slice(start).filter((n) => n.method === "notifications/subscriptions/acknowledged")).toHaveLength(1);
		expect(client.lines.some((l) => { const m = JSON.parse(l); return m.id === 41 && !("method" in m); })).toBe(false);
		// The reopened stream gets the screen's updates.
		const seen = client.notifications().length;
		await world.person({ event: { screen: "desk/tasks", name: "settle", payload: { rowId: "7" } } });
		await until(() => client.notifications().slice(seen).some((n) => n.method === "notifications/resources/updated" && n.params._meta[SUB] === 41), 3000, "an update after reconnecting");
		await world.person({ event: { screen: "desk/tasks", name: "reopen-all" } });
		send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41 } });
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

// Acting (B1.3): run_action and fill_form in a world with a plugin agents may act on.
describe("MCP conformance: acting", () => {
	let acting: World;
	const own: McpAdapter[] = [];
	beforeAll(async () => {
		acting = await createWorld({ acting: true });
	});
	afterAll(async () => {
		for (const c of own) await c.close();
		await acting.stop();
	});
	const MODERN = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "acting-conformance", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
	async function connect(initialize: boolean) {
		const client = new McpAdapter({ socket: acting.socket, autonomous: false, client: "acting-conformance" });
		own.push(client);
		const c = (await client.connection(initialize))!;
		return { ...c, client };
	}
	const eras = [
		{ era: "legacy", initialize: true, meta: (extra: Record<string, unknown> = {}) => (Object.keys(extra).length ? { _meta: extra } : {}) },
		{ era: "modern", initialize: false, meta: (extra: Record<string, unknown> = {}) => ({ _meta: { ...MODERN, ...extra } }) },
	] as const;

	for (const { era, initialize, meta } of eras) {
		test(`${era}: refusals and denials are isError results, not JSON-RPC errors`, async () => {
			const { request } = await connect(initialize);
			const call = async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args, ...meta() })).result;
			// A plugin agents may only read, an unknown action, a secret field.
			for (const [name, args] of [
				["run_action", { plugin: "desk", screen: "tasks", action: "settle", row: "1" }],
				["run_action", { plugin: "errands", screen: "list", action: "explode" }],
				["fill_form", { plugin: "errands", screen: "list", form: "details", row: "e1", values: { code: "1" } }],
			] as const) {
				const r = await call(name, args);
				expect(r.isError).toBe(true);
				expect(r.structuredContent).toBeUndefined();
			}
			// The person says no.
			const pending = call("run_action", { plugin: "errands", screen: "list", action: "remove", row: "e2" });
			const asked = await until(() => acting.agents.core.state().approvals.find((a) => a.change), 4000, "the approval");
			acting.agents.handle({ operation: "answer", id: asked.id, allow: false });
			const denied = await pending;
			expect(denied.isError).toBe(true);
			expect(denied.content[0].text).toContain("The person didn't allow this");
			// A view action runs without asking; JSON carries the same as text.
			const json = await call("run_action", { plugin: "errands", screen: "list", action: "copy-list", format: "json" });
			expect(json.isError).toBeUndefined();
			expect(JSON.parse(json.content[0].text)).toEqual(json.structuredContent);
			expect(json.structuredContent).toMatchObject({ outcome: "done", approval: "none", action: { id: "copy-list", effect: "view" }, clipboard: [expect.any(String)], atIso: expect.any(String) });
			if (era === "modern") expect(json.resultType).toBe("complete");
		});

		test(`${era}: an approval wait reports progress, and cancelling withdraws its dialog`, async () => {
			const { send, client } = await connect(initialize);
			const id = `wait-${era}`;
			const start = client.notifications().length;
			send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "run_action", arguments: { plugin: "errands", screen: "list", action: "remove", row: "e4" }, ...meta({ progressToken: `progress-${era}` }) } });
			await until(() => acting.agents.core.state().approvals.some((a) => a.change), 4000, "the approval");
			const progress = await until(() => client.notifications().slice(start).find((n) => n.method === "notifications/progress"), 4000, "progress");
			expect(progress.params).toMatchObject({ progressToken: `progress-${era}`, message: "Waiting for your approval in ToolBelt", total: 3 });
			send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "the person changed their mind" } });
			// The dialog goes from every screen, nothing runs, and the cancelled request gets no response.
			await until(() => !acting.agents.core.state().approvals.length, 4000, "the dialog to go");
			await Bun.sleep(200);
			expect(client.lines.map((l) => JSON.parse(l)).some((m) => m.id === id)).toBe(false);
			const audit = acting.audit().filter((a) => a.operation === "run_action" && a.action === "remove");
			expect(audit.at(-1)).toMatchObject({ outcome: "denied", approval: "cancelled", effect: "destructive", rows: 1 });
			expect((await acting.state()).removed).toEqual([]);
		});
	}
});
