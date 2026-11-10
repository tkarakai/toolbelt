// Exercise the shipped shape through the real host, with only scratch-file recipes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../src/bun/host";
import { parseManifest, type Node } from "../src/shared/protocol";
import { bulkUpdatable } from "../plugins/upkeep/lib/engine";
import { customCandidate } from "../plugins/upkeep/providers/custom";
import type { Item } from "../plugins/upkeep/lib/types";

const root = mkdtempSync(join(tmpdir(), "toolbelt-upkeep-integration-"));
const bundle = join(root, "plugin");
const source = join(import.meta.dir, "../plugins/upkeep");
let host: PluginHost | undefined;

beforeAll(async () => {
	mkdirSync(bundle);
	const result = await Bun.build({ entrypoints: [join(source, "index.ts")], target: "bun", outdir: bundle });
	if (!result.success) throw new Error(result.logs.join("\n"));
	const manifest = parseManifest(JSON.parse(readFileSync(join(source, "toolbelt.json"), "utf8")));
	writeFileSync(join(bundle, "toolbelt.json"), JSON.stringify({ ...manifest, entry: "index.js" }));
});

afterAll(async () => {
	host?.stop();
	await Bun.sleep(100);
	rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 5000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("Timed out waiting for Upkeep");
		await Bun.sleep(20);
	}
}

test("bundled Upkeep: all screens, explicit opt-in, review, update, logs and restart", async () => {
	const data = join(root, "data");
	const trees = new Map<string, Node>();
	const toasts: string[] = [];
	host = new PluginHost({ dirs: [bundle], bun: process.execPath, host: { name: "test", version: "0" }, data,
		// Skip login-shell startup files; the fake recipe needs only absolute paths.
		env: { ...process.env, SHELL: "/usr/bin/true" } });
	host.subscribe({ plugins: () => {}, tree: (_p, surface, tree) => trees.set(surface, tree), toast: (_p, text) => toasts.push(text) });
	host.start();
	const manifest = host.list()[0].manifest;
	expect(manifest.id).toBe("upkeep");
	expect(manifest.repo).toBe("https://github.com/tkarakai/toolbelt-upkeep");
	for (const surface of [...manifest.screens.map((s) => `screen:${s.id}`), "quick"]) host.open("upkeep", surface);
	await until(() => trees.size === 6);
	for (const tree of trees.values()) expect(JSON.stringify(tree)).not.toContain("failed to render");
	expect(JSON.stringify(trees.get("screen:monitored"))).toContain("Nothing watched yet");
	expect(JSON.stringify(trees.get("screen:settings"))).toContain('"value":"6"');
	expect(existsSync(join(data, "upkeep/discovered.json"))).toBe(false);
	expect(existsSync(join(data, "upkeep/items.json"))).toBe(false);
	expect(existsSync(join(data, "upkeep/audit.jsonl"))).toBe(false);

	// Seed a harmless discovered recipe, without scanning the person's Mac.
	const candidate = customCandidate({ name: "Discover toggle fixture", version: "/bin/echo 1.0.0", latest: "/bin/echo 1.0.0", update: "/usr/bin/true" });
	writeFileSync(join(data, "upkeep/discovered.json"), JSON.stringify({ at: Date.now(), candidates: [candidate], errors: {} }));
	trees.clear();
	host.restart("upkeep");
	await until(() => trees.size === 6);
	const discoverTable = () => {
		const find = (node: any): any => node?.type === "table" && node.id === "candidates" ? node : (node?.children ?? []).map(find).find(Boolean);
		return find(trees.get("screen:discover"));
	};
	for (const action of ["monitor", "remove", "monitor", "remove"]) {
		const table = discoverTable();
		expect(table.rows[0].id).toBe(candidate.id);
		expect(table.rows[0].actions).toEqual([action]);
		expect(table.actions.find((a: any) => a.id === action).confirm).toBeUndefined();
		host.event("upkeep", "screen:discover", action, { rowId: candidate.id });
		await until(() => discoverTable().rows[0].actions[0] !== action);
		expect(JSON.parse(readFileSync(join(data, "upkeep/items.json"), "utf8")).some((it: Item) => it.id === candidate.id)).toBe(action === "monitor");
	}
	// Keep the recipe audit assertions below independent of the toggle fixture.
	writeFileSync(join(data, "upkeep/audit.jsonl"), "");
	trees.clear();
	host.restart("upkeep");
	await until(() => trees.size === 6);

	const version = join(root, "version");
	writeFileSync(version, "1.0.0\n");
	const event = (name: string, payload?: unknown) => host!.event("upkeep", "screen:settings", name, payload);
	event("add-recipe");
	const fields = { name: "Integration fixture", version: `/bin/cat '${version}'`, latest: "/bin/echo 1.1.0", update: `/bin/echo 1.1.0 > '${version}'` };
	for (const [field, value] of Object.entries(fields)) event("field", { form: "recipe", field, value });
	event("recipe-save");
	const items = () => JSON.parse(readFileSync(join(data, "upkeep/items.json"), "utf8")) as Item[];
	await until(() => existsSync(join(data, "upkeep/items.json")) && items()[0]?.state.latest === "1.1.0");
	expect(items()[0]).toMatchObject({ policy: "notify", state: { installed: "1.0.0", outdated: true } });
	expect(readFileSync(version, "utf8").trim()).toBe("1.0.0");
	await until(() => host!.list()[0].badge === 1);

	host.event("upkeep", "screen:monitored", "review", { rowId: items()[0].id });
	await until(() => JSON.stringify(trees.get("screen:monitored")).includes("What will run"));
	expect(JSON.stringify(trees.get("screen:monitored"))).toContain("Update now");
	host.event("upkeep", "screen:monitored", "update");
	await until(() => items()[0].state.installed === "1.1.0");
	expect(readFileSync(version, "utf8").trim()).toBe("1.1.0");
	await until(() => JSON.stringify(trees.get("screen:activity")).includes("Updated 1.0.0"));
	const audit = readFileSync(join(data, "upkeep/audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	expect(audit.map((a) => a.event)).toEqual(["added", "changed", "check", "started", "update"]);
	const job = audit.at(-1).job;
	expect(readFileSync(join(data, "upkeep/logs", `${job}.log`), "utf8")).toContain("Updated 1.0.0 → 1.1.0");
	expect(toasts).toContain("Updating Integration fixture; see Queue");

	trees.clear();
	host.restart("upkeep");
	await until(() => trees.size === 6);
	expect(JSON.stringify(trees.get("screen:monitored"))).toContain("Integration fixture");
	expect(items()[0].state.installed).toBe("1.1.0");
}, 15_000);

test("bulk updates exclude major upgrades, apps, passwords, pins and skipped versions", () => {
	const item: Item = { id: "brew:fixture", provider: "brew", ref: "fixture", name: "Fixture", kind: "package", identity: "tool:fixture", data: {}, policy: "notify", addedAt: 0,
		state: { installed: "1.0.0", latest: "1.1.0", outdated: true, failures: 0, nextAt: 0 } };
	expect(bulkUpdatable(item)).toBe(true);
	for (const patch of [{ pinned: true }, { skip: "1.1.0" }, { kind: "app" as const }, { data: { auth: "1" } }, ...["custom", "sparkle", "go"].map((provider) => ({ provider }))]) {
		expect(bulkUpdatable({ ...item, ...patch })).toBe(false);
	}
	for (const patch of [{ latest: "2.0.0" }, { needsAuth: true }, { blocked: "Local changes" }, { outdated: false }]) {
		expect(bulkUpdatable({ ...item, state: { ...item.state, ...patch } })).toBe(false);
	}
});
