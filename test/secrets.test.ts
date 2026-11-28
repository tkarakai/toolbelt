// Plugin secrets (capability `secrets`): the store, tree handling, the host's Keychain write path
// and the SDK. Everything runs against the in-memory backend; the real Keychain is checked only
// with TOOLBELT_TEST_KEYCHAIN=1, under a throwaway service it deletes again.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../src/bun/host";
import {
	KeychainBackend,
	MemorySecretBackend,
	PluginSecrets,
	SecretStore,
	annotateSecrets,
	findSecretField,
	planEnvironment,
	profileKey,
	secretService,
} from "../src/bun/secrets";
import { LIMITS } from "../src/shared/package";
import type { HostMessage, Node, PluginMessage } from "../src/shared/protocol";
import { validateMessage, validateTree } from "../src/shared/validation";
import { fakeHost } from "../src/sdk/testing";

async function until<T>(check: () => T | undefined | false, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = check();
		if (v) return v;
		await Bun.sleep(20);
	}
	throw new Error("timed out");
}

describe("store", () => {
	test("services are bound to the plugin, its publisher and the profile", () => {
		expect(secretService("agent", "Owner/Repo", null)).toBe("ToolBelt:owner/repo:agent");
		expect(secretService("agent", "other/repo", null)).not.toBe(secretService("agent", "owner/repo", null));
		const official = "/Users/x/Library/Application Support/Toolbelt";
		expect(profileKey(official, official)).toBeNull();
		const dev = profileKey("/Users/x/Library/Application Support/Toolbelt Dev", official);
		const development = profileKey(`${official}/development/try`, official);
		expect(dev).toMatch(/^[0-9a-f]{12}$/);
		expect(development).not.toBe(dev);
		expect(secretService("agent", "owner/repo", dev)).toBe(`ToolBelt:owner/repo:agent:${dev}`);
	});

	test("keeps names, refuses bad names and values, and deletes everything", async () => {
		const backend = new MemorySecretBackend();
		const store = new SecretStore(backend, null, () => {});
		const secrets = store.forPlugin({ id: "p", name: "Plugin", repo: "o/p" });
		expect(store.forPlugin({ id: "p", name: "Plugin", repo: "o/p" })).toBe(secrets);
		expect(await secrets.has("api/key")).toBe(false);
		await secrets.set("api/key", "sk-1");
		expect(backend.items.get("ToolBelt:o/p:p")!.get("api/key")).toEqual({ value: "sk-1", label: "ToolBelt · Plugin · api/key" });
		expect(await secrets.get("api/key")).toBe("sk-1");
		expect(await secrets.has("api/key")).toBe(true);
		expect(secrets.stored("api/key")).toBe(true);
		await expect(secrets.set("bad name", "x")).rejects.toThrow("name");
		await expect(secrets.set("../x\n", "x")).rejects.toThrow("name");
		await expect(secrets.set("a", "")).rejects.toThrow("empty");
		await expect(secrets.set("a", "x".repeat(LIMITS.secretBytes + 1))).rejects.toThrow("bytes");
		// Another publisher's plugin with the same id sees nothing.
		expect(await store.forPlugin({ id: "p", name: "Plugin", repo: "evil/p" }).get("api/key")).toBeNull();
		await store.deleteAll({ id: "p", name: "Plugin", repo: "o/p" });
		expect(await backend.list("ToolBelt:o/p:p")).toEqual([]);
		expect(secrets.stored("api/key")).toBe(false);
	});

	test("caps how many secrets a plugin keeps", async () => {
		const backend = new MemorySecretBackend();
		const secrets = new PluginSecrets(backend, "s", "P", () => {});
		for (let i = 0; i < LIMITS.secrets; i++) await backend.set("s", `n${i}`, "v", "l");
		await expect(secrets.set("one-more", "v")).rejects.toThrow(`at most ${LIMITS.secrets}`);
		await secrets.set("n0", "replaced"); // replacing is fine
		expect(await secrets.get("n0")).toBe("replaced");
	});

	test("a failing backend is logged without values and doesn't throw on removal", async () => {
		const lines: string[] = [];
		const failing = new MemorySecretBackend();
		failing.list = async () => {
			throw new Error("Keychain locked");
		};
		const store = new SecretStore(failing, null, (l) => lines.push(l));
		await store.deleteAll({ id: "p", name: "P", repo: "o/p" });
		expect(lines.join("\n")).toContain("couldn't delete the Keychain items: Keychain locked");
	});
});

describe("trees", () => {
	const tree: Node = {
		type: "page",
		children: [
			{ type: "form", id: "settings", fields: [{ type: "text", id: "key", label: "API key", value: "", secret: "openai/key" }] },
			{
				type: "table",
				id: "agents",
				columns: [{ key: "name", title: "Name" }],
				rows: [
					{ id: "a1", cells: { name: "One" }, pane: [{ type: "form", id: "agent", fields: [{ type: "environment", id: "env", label: "Environment", secretPrefix: "agents/a1", value: [{ key: "TOKEN", value: "", selected: true, secret: true }, { key: "REGION", value: "eu", selected: true, secret: false }] }] }] },
					{ id: "a2", cells: { name: "Two" }, pane: [{ type: "form", id: "agent", fields: [{ type: "environment", id: "env", label: "Environment", secretPrefix: "agents/a2", value: [] }] }] },
				],
			},
		],
	} as Node;

	test("validate", () => {
		validateTree(tree);
		expect(() => validateTree({ type: "form", id: "f", fields: [{ type: "text", id: "k", label: "K", value: "sk-leak", secret: "k" }] })).toThrow("value");
		expect(() => validateTree({ type: "form", id: "f", fields: [{ type: "text", id: "k", label: "K", value: "", secret: "bad name" }] })).toThrow("secret");
		expect(() =>
			validateTree({ type: "form", id: "f", fields: [{ type: "environment", id: "e", label: "E", secretPrefix: "e", value: [{ key: "T", value: "leak", selected: true, secret: true }] }] }),
		).toThrow("value[0].value");
		// Without `secretPrefix`, secret entries keep today's behavior (the plugin holds the value).
		validateTree({ type: "form", id: "f", fields: [{ type: "environment", id: "e", label: "E", value: [{ key: "T", value: "plain", selected: true, secret: true }] }] });
	});

	test("annotate marks what's stored and keeps unchanged trees", () => {
		const stored = new Set(["openai/key", "agents/a1/TOKEN"]);
		const out = annotateSecrets(tree, (n) => stored.has(n));
		expect(out).not.toBe(tree);
		expect(JSON.stringify(out)).toContain('"secret":"openai/key","stored":true');
		expect(JSON.stringify(out)).toContain('"key":"TOKEN","value":"","selected":true,"secret":true,"stored":true');
		expect(JSON.stringify(out)).not.toContain('"key":"REGION","value":"eu","selected":true,"secret":false,"stored"');
		expect(annotateSecrets(out, (n) => stored.has(n))).toBe(out);
		expect(annotateSecrets({ type: "text", text: "x" }, () => true)).toEqual({ type: "text", text: "x" });
	});

	test("finds a field by form, id and the row whose pane holds it", () => {
		expect(findSecretField(tree, "settings", "key", undefined)).toMatchObject({ secret: "openai/key" });
		expect(findSecretField(tree, "agent", "env", "a2")).toMatchObject({ secretPrefix: "agents/a2" });
		expect(findSecretField(tree, "agent", "env", undefined)).toBeNull();
		expect(findSecretField(tree, "settings", "other", undefined)).toBeNull();
	});

	test("plans an environment field's writes and deletes", () => {
		const plan = planEnvironment(
			"agents/a1",
			[
				{ key: "TOKEN", value: "new-token", selected: true, secret: true },
				{ key: "KEPT", value: "", selected: false, secret: true },
				{ key: "bad key", value: "lost", selected: true, secret: true },
				{ key: "REGION", value: "eu", selected: true, secret: false },
			],
			// What the field showed: GONE was removed; a plain entry is never a Keychain name.
			[
				{ key: "TOKEN", value: "", selected: true, secret: true, stored: true },
				{ key: "KEPT", value: "", selected: false, secret: true, stored: true },
				{ key: "GONE", value: "", selected: true, secret: true, stored: true },
				{ key: "PLAIN", value: "x", selected: true, secret: false },
			],
		);
		expect(plan.writes).toEqual([{ name: "agents/a1/TOKEN", value: "new-token" }]);
		expect(plan.deletes).toEqual(["agents/a1/GONE"]);
		expect(plan.invalid).toEqual(["bad key"]);
		expect(JSON.stringify(plan.entries)).not.toContain("new-token");
		expect(JSON.stringify(plan.entries)).not.toContain("lost");
		expect(plan.entries[3]).toEqual({ key: "REGION", value: "eu", selected: true, secret: false });
	});

	test("secret messages", () => {
		validateMessage({ type: "secret", requestId: "s1", op: "get", name: "a/b" });
		validateMessage({ type: "secret", requestId: "s1", op: "set", name: "a/b", value: "v" });
		expect(() => validateMessage({ type: "secret", requestId: "s1", op: "set", name: "a/b" })).toThrow();
		expect(() => validateMessage({ type: "secret", requestId: "s1", op: "get", name: "a/b", value: "v" })).toThrow();
		expect(() => validateMessage({ type: "secret", requestId: "s1", op: "set", name: "a/b", value: "x".repeat(LIMITS.secretBytes + 1) })).toThrow();
		expect(() => validateMessage({ type: "secret", requestId: "s1", op: "list", name: "a" })).toThrow();
		expect(() => validateMessage({ type: "secret", requestId: "s1", op: "get", name: "" })).toThrow();
	});
});

describe("SDK", () => {
	const hello = (capabilities: string[]): HostMessage => ({ type: "hello", protocol: 3, capabilities, plugin: { id: "p" }, host: { name: "t", version: "0" } });

	test("asks the host and gets answers, also from inside an event handler", async () => {
		const got: (string | null)[] = [];
		const h = fakeHost({
			render: {},
			onEvent: async (_s, _n, _p, ctx) => {
				got.push(await ctx.secrets.get("api/key"));
			},
		});
		h.send(hello(["ui.core", "secrets"]));
		await until(() => h.messages.some((m) => m.type === "ready"));
		h.send({ type: "event", id: "e1", surface: "screen:main", instance: "person", name: "go", origin: "person" });
		const request = await until(() => h.messages.find((m): m is Extract<PluginMessage, { type: "secret" }> => m.type === "secret"));
		expect(request).toMatchObject({ op: "get", name: "api/key" });
		// The event handler is still waiting; the answer must reach it anyway.
		h.send({ type: "secret", requestId: request.requestId, ok: true, value: "sk-1" });
		await until(() => got.length);
		expect(got).toEqual(["sk-1"]);

		const set = h.context.secrets.set("api/key", "sk-2");
		const setRequest = await until(() => [...h.messages].reverse().find((m): m is Extract<PluginMessage, { type: "secret" }> => m.type === "secret" && m.op === "set"));
		expect(setRequest.value).toBe("sk-2");
		h.send({ type: "secret", requestId: setRequest.requestId, ok: false, error: "Keychain locked" });
		await expect(set).rejects.toThrow("Keychain locked");
		h.close();
	});

	test("refuses without the host's capability, or with a bad name, without asking", async () => {
		const h = fakeHost({ render: {} });
		h.send(hello(["ui.core"]));
		await until(() => h.messages.some((m) => m.type === "ready"));
		await expect(h.context.secrets.get("a")).rejects.toThrow("capability");
		h.close();
		const h2 = fakeHost({ render: {} });
		h2.send(hello(["ui.core", "secrets"]));
		await until(() => h2.messages.some((m) => m.type === "ready"));
		await expect(h2.context.secrets.get("bad name")).rejects.toThrow("name");
		await expect(h2.context.secrets.set("a", "")).rejects.toThrow("non-empty");
		expect(h2.messages.some((m) => m.type === "secret")).toBe(false);
		h2.close();
	});
});

describe("host", () => {
	const sdk = join(import.meta.dir, "../src/sdk");
	let host: PluginHost | undefined;
	afterEach(() => host?.stop());

	/** A plugin in a temporary folder: a form with a secret field and a Keychain-backed environment field. */
	function fixture(capabilities: string[]) {
		const root = mkdtempSync(join(tmpdir(), "toolbelt-secrets-"));
		const dir = join(root, "vault");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "toolbelt.json"),
			JSON.stringify({
				id: "vault",
				name: "Vault",
				version: "1.0.0",
				protocol: 3,
				repo: "owner/vault",
				agent: { access: "read" },
				entry: "index.ts",
				capabilities: { required: ["ui.core", ...capabilities], optional: [] },
				screens: [{ id: "main", title: "Main", default: true }],
			}),
		);
		writeFileSync(
			join(dir, "index.ts"),
			`import { definePlugin } from ${JSON.stringify(sdk)};
let env = [{ key: "REGION", value: "eu", selected: true, secret: false }];
const events = [];
definePlugin({
	start: async (ctx) => {
		// start() may read a secret before the plugin is ready.
		try { events.push("start:" + String(await ctx.secrets.has("api/key"))); } catch (e) { events.push("start-error:" + e.message); }
	},
	actions: { use: { effect: "external" }, write: { effect: "write" } },
	forms: { settings: { effect: "write" } },
	render: {
		"screen:main": () => ({ type: "page", actions: [{ id: "use", label: "Use" }, { id: "write", label: "Write" }], children: [
			{ type: "form", id: "settings", fields: [
				{ type: "text", id: "key", label: "API key", value: "", secret: "api/key" },
				{ type: "environment", id: "env", label: "Environment", secretPrefix: "env", value: env },
			] },
			{ type: "text", text: "events\\n" + events.join("\\n") },
		] }),
	},
	onEvent: async (_s, name, payload, ctx) => {
		events.push(JSON.stringify({ name, payload }));
		if (name === "field" && payload.field === "env") env = payload.value;
		if (name === "use") {
			try { const a = await ctx.secrets.get("api/key"), b = await ctx.secrets.get("env/TOKEN"); events.push("use:" + Bun.hash(String(a)) + "|" + Bun.hash(String(b))); } catch (e) { events.push("use-error:" + e.message); }
		}
		if (name === "write") {
			try { await ctx.secrets.set("other", "from-plugin"); events.push("wrote"); } catch (e) { events.push("write-error:" + e.message); }
		}
		ctx.invalidate();
	},
});
`,
		);
		return root;
	}

	function start(capabilities: string[]) {
		const backend = new MemorySecretBackend();
		const trees: Node[] = [];
		const toasts: string[] = [];
		const diagnostics: string[] = [];
		const logs: string[] = [];
		host = new PluginHost({
			dirs: [fixture(capabilities)],
			bun: process.execPath,
			host: { name: "test", version: "0" },
			data: mkdtempSync(join(tmpdir(), "toolbelt-secrets-data-")),
			secrets: new SecretStore(backend, "test", (l) => logs.push(l)),
			diagnostic: (_p, kind, detail) => diagnostics.push(`${kind} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`),
		});
		host.subscribe({ plugins: () => {}, tree: (_p, _s, tree) => trees.push(tree), toast: (_p, t) => toasts.push(t) });
		host.start();
		host.open("vault", "screen:main");
		const last = () => JSON.stringify(trees.at(-1) ?? null);
		/** What the plugin heard, one line per event (its screen's last text). */
		const heard = () => (((trees.at(-1) as { children?: { type: string; text?: string }[] } | undefined)?.children ?? []).find((c) => c.type === "text")?.text ?? "");
		return { backend, trees, toasts, diagnostics, logs, last, heard, service: "ToolBelt:owner/vault:vault:test" };
	}

	test("the person's secret goes to the Keychain; the plugin hears only that it's saved", async () => {
		const s = start(["secrets"]);
		await until(() => s.last().includes('"secret":"api/key","stored":false') && s.heard().includes("start:false"));

		host!.event("vault", "screen:main", "field", { form: "settings", field: "key", value: "sk-live-123", secret: "api/key" });
		await until(() => s.last().includes('"secret":"api/key","stored":true') && s.heard().includes('"value":true'));
		expect(await s.backend.get(s.service, "api/key")).toBe("sk-live-123");
		expect(s.heard()).toContain('{"name":"field","payload":{"form":"settings","field":"key","value":true,"secret":"api/key"}}');

		// Environment: the secret entry's value is stored as env/TOKEN; the plugin gets it without.
		host!.event("vault", "screen:main", "field", {
			form: "settings",
			field: "env",
			secret: "env",
			value: [
				{ key: "REGION", value: "eu", selected: true, secret: false },
				{ key: "TOKEN", value: "tok-456", selected: true, secret: true },
			],
		});
		await until(() => s.last().includes('"key":"TOKEN","value":"","selected":true,"secret":true,"stored":true'));
		expect(await s.backend.get(s.service, "env/TOKEN")).toBe("tok-456");

		// The plugin reads both when it needs them.
		host!.event("vault", "screen:main", "use");
		await until(() => s.heard().includes(`use:${Bun.hash("sk-live-123")}|${Bun.hash("tok-456")}`));

		// Removing the entry deletes its secret; Remove on the field deletes the field's.
		host!.event("vault", "screen:main", "field", { form: "settings", field: "env", secret: "env", value: [{ key: "REGION", value: "eu", selected: true, secret: false }] });
		await until(() => !s.backend.items.get(s.service)?.has("env/TOKEN"));
		host!.event("vault", "screen:main", "field", { form: "settings", field: "key", value: null, secret: "api/key" });
		await until(() => s.last().includes('"secret":"api/key","stored":false'));
		expect(await s.backend.get(s.service, "api/key")).toBeNull();

		// No value ever reached a tree, the plugin or the diagnostic log.
		const everything = JSON.stringify(s.trees) + s.diagnostics.join("\n") + s.logs.join("\n");
		expect(everything).not.toContain("sk-live-123");
		expect(everything).not.toContain("tok-456");
		expect(s.diagnostics.some((d) => d.includes("[secret]"))).toBe(true);
	});

	test("an event marked secret for a field that isn't one is dropped, not delivered", async () => {
		const s = start(["secrets"]);
		await until(() => s.last().includes('"stored":false'));
		host!.event("vault", "screen:main", "field", { form: "settings", field: "renamed", value: "sk-stale", secret: "api/key" });
		await until(() => s.toasts.length);
		expect(s.toasts[0]).toContain("changed before ToolBelt could save it");
		host!.event("vault", "screen:main", "use");
		await until(() => s.heard().includes("use:"));
		expect(JSON.stringify(s.trees)).not.toContain("sk-stale");
	});

	test("the plugin's own writes work, and a Keychain failure is reported without the value", async () => {
		const s = start(["secrets"]);
		await until(() => s.heard().includes("start:false"));
		host!.event("vault", "screen:main", "write");
		await until(() => s.heard().includes("wrote"));
		expect(await s.backend.get(s.service, "other")).toBe("from-plugin");
		s.backend.set = async () => {
			throw new Error("User canceled the operation");
		};
		host!.event("vault", "screen:main", "field", { form: "settings", field: "key", value: "sk-fails", secret: "api/key" });
		await until(() => s.toasts.length);
		expect(s.toasts[0]).toContain("User canceled");
		expect(s.toasts.join() + s.logs.join() + JSON.stringify(s.trees)).not.toContain("sk-fails");
		expect(s.last()).not.toContain('"stored":true');
	});

	test("without the capability, secret fields are refused and requests answered with an error", async () => {
		const s = start([]);
		await until(() => s.last().includes("couldn't be shown"));
		expect(s.last()).toContain("secrets capability");
		await host!.deleteSecrets({ id: "vault", name: "Vault", repo: "owner/vault" });
		expect(s.backend.items.size).toBe(0);
	});
});

describe.if(process.env.TOOLBELT_TEST_KEYCHAIN === "1")("real Keychain", () => {
	test("stores, lists, replaces and deletes under a throwaway service", async () => {
		const keychain = new KeychainBackend();
		const service = `ToolBelt-test:${crypto.randomUUID()}`;
		try {
			expect(await keychain.list(service)).toEqual([]);
			expect(await keychain.get(service, "a/b")).toBeNull();
			await keychain.set(service, "a/b", "first ✓", "ToolBelt · Test · a/b");
			await keychain.set(service, "a/b", "second", "ToolBelt · Test · a/b");
			await keychain.set(service, "c", "third", "ToolBelt · Test · c");
			expect(await keychain.get(service, "a/b")).toBe("second");
			expect((await keychain.list(service)).sort()).toEqual(["a/b", "c"]);
			await keychain.delete(service, "a/b");
			await keychain.delete(service, "a/b"); // already gone: fine
			expect(await keychain.list(service)).toEqual(["c"]);
		} finally {
			for (const name of await keychain.list(service)) await keychain.delete(service, name);
		}
		expect(await keychain.list(service)).toEqual([]);
	});
});
