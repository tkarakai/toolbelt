// The change journal (src/bun/journal.ts): what the host records for each change made through a
// plugin's screens, against a real plugin process (the ledger fixture), and the hash chain's checks.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, type Actor, type EventSettled } from "../src/bun/host";
import { ChangeJournal, GENESIS, canonical, entryHash, verifyJournal, type JournalEntry } from "../src/bun/journal";
import { PackageManager } from "../src/bun/packages";

const fixture = join(import.meta.dir, "fixtures/journal/ledger");
const temps: string[] = [];
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until<T>(check: () => T | undefined | false | null, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = check();
		if (v) return v;
		await Bun.sleep(20);
	}
	throw new Error("timed out");
}

const lines = (file: string): JournalEntry[] =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

describe("the host journals changes made through plugin screens (the ledger fixture)", () => {
	let host: PluginHost | undefined;
	afterEach(async () => {
		if (host) await host.stopPlugin("ledger");
		host = undefined;
	});

	async function start(file?: string) {
		const profile = temp("toolbelt-journal-");
		const journalFile = file ?? join(profile, "journal/changes.jsonl");
		const journal = new ChangeJournal(journalFile, { log: () => {} });
		const settled: EventSettled[] = [];
		host = new PluginHost({ dirs: [fixture], bun: process.execPath, host: { name: "test", version: "0" }, data: join(profile, "data"), journal });
		host.subscribe({ plugins: () => {}, tree: () => {}, toast: () => {}, settled: (e) => settled.push(e) });
		host.start();
		await until(() => host!.list()[0]?.state === "running");
		host.open("ledger", "screen:main");
		await until(() => host!.snapshot("ledger", "screen:main")?.tree);
		/** Sends a person's event and waits for it to settle. */
		const send = async (name: string, payload: unknown, actor?: Parameters<PluginHost["event"]>[4], surface = "screen:main") => {
			const id = host!.event("ledger", surface, name, payload, actor);
			expect(id).not.toBeNull();
			return until(() => settled.find((e) => e.id === id));
		};
		return { profile, journal, journalFile, settled, send };
	}

	test("one entry per change from the window, the popover and a paired device", async () => {
		const { journal, journalFile, send } = await start();
		const window = await send("done", { rowId: "r1" });
		await send("done-all", { rowIds: ["r1", "r2"] }, { kind: "person", via: "popover" });
		const remote = await send("purge", { rowId: "r2" }, { kind: "person", via: "remote", device: "Phone" });
		await send("open-link", {});
		// The toast's Undo is a write action too.
		await send("undo", null, undefined, "toast");
		journal.flush();
		const entries = lines(journalFile);
		expect(entries.map(({ hash: _, at: __, event: ___, ...e }) => e)).toEqual([
			{ seq: 1, actor: { kind: "person", via: "window" }, plugin: "ledger", surface: "screen:main", name: "done", effect: "write", rows: ["r1"], outcome: "ok" },
			{ seq: 2, actor: { kind: "person", via: "popover" }, plugin: "ledger", surface: "screen:main", name: "done-all", effect: "write", rows: ["r1", "r2"], outcome: "ok" },
			{ seq: 3, actor: { kind: "person", via: "remote", device: "Phone" }, plugin: "ledger", surface: "screen:main", name: "purge", effect: "destructive", rows: ["r2"], outcome: "ok" },
			{ seq: 4, actor: { kind: "person", via: "window" }, plugin: "ledger", surface: "screen:main", name: "open-link", effect: "external", outcome: "ok" },
			{ seq: 5, actor: { kind: "person", via: "window" }, plugin: "ledger", surface: "toast", name: "undo", effect: "write", outcome: "ok" },
		]);
		expect(entries[0].event).toBe(window.id);
		expect(entries[2].event).toBe(remote.id);
		expect(entries[0].at).toBeLessThanOrEqual(Date.now());
		expect(window.change).toMatchObject({ name: "done", effect: "write", rows: ["r1"] });
		expect(verifyJournal(journalFile)).toMatchObject({ entries: 5, breakCount: 0, last: { seq: 5, hash: entries[4].hash } });
		expect(journal.read(2).map((e) => e.seq)).toEqual([5, 4]);
	});

	test("moving a row (reorder) is journaled as a write", async () => {
		const { journal, journalFile, send } = await start();
		await send("reorder", { table: "tasks", rowId: "r2", section: "", before: "r1" });
		journal.flush();
		expect(lines(journalFile).map(({ name, effect, rows, outcome }) => ({ name, effect, rows, outcome }))).toEqual([{ name: "reorder", effect: "write", rows: ["r2"], outcome: "ok" }]);
	});

	test("view events, view actions, view forms and select change nothing and aren't journaled", async () => {
		const { journal, journalFile, settled, send } = await start();
		await send("search", { query: "secret" });
		await send("select", { table: "tasks", rowId: "r1" });
		await send("new", {}); // opens the dialog
		await until(() => JSON.stringify(host!.snapshot("ledger", "screen:main")?.tree).includes('"draft"'));
		await send("field", { form: "draft", field: "name", value: "TYPED-DRAFT" });
		await send("dialog-close", { dialog: "draft" });
		journal.flush();
		expect(settled.every((e) => e.change === undefined)).toBe(true);
		expect(lines(journalFile)).toEqual([]);
		// The action that saves the draft is journaled.
		await send("new", {});
		await until(() => JSON.stringify(host!.snapshot("ledger", "screen:main")?.tree).includes('"draft"'));
		await send("create", { dialog: "draft" });
		journal.flush();
		expect(lines(journalFile).map((e) => e.name)).toEqual(["create"]);
	});

	test("field events on a write form coalesce per field, row and actor", async () => {
		const { journal, journalFile, send } = await start();
		const first = await send("field", { form: "pane", field: "note", value: "TYPED-1", rowId: "r1" });
		await send("field", { form: "pane", field: "note", value: "TYPED-2", rowId: "r1" });
		await send("field", { form: "pane", field: "note", value: "TYPED-3", rowId: "r1" });
		// Another row, then another actor: entries of their own.
		await send("field", { form: "pane", field: "note", value: "TYPED-4", rowId: "r2" });
		await send("field", { form: "pane", field: "note", value: "TYPED-5", rowId: "r2" }, { kind: "person", via: "remote", device: "Phone" });
		// A page form with no row.
		await send("field", { form: "prefs", field: "theme", value: "TYPED-6" });
		journal.flush();
		const entries = lines(journalFile);
		expect(entries.map((e) => [e.name, e.rows ?? [], e.actor.kind === "person" ? e.actor.via : "agent"])).toEqual([
			["pane.note", ["r1"], "window"],
			["pane.note", ["r2"], "window"],
			["pane.note", ["r2"], "remote"],
			["prefs.theme", [], "window"],
		]);
		// The entry keeps the first event's id and time.
		expect(entries[0]).toMatchObject({ event: first.id, at: first.change!.at, effect: "write", outcome: "ok" });
		expect(verifyJournal(journalFile).breakCount).toBe(0);
	});

	test("outcomes: ok, not handled, error and no answer", async () => {
		const { journal, journalFile, settled, send } = await start();
		for (const name of ["open-link", "skip", "fail"]) await send(name, {});
		const id = host!.event("ledger", "screen:main", "stall", {});
		await Bun.sleep(100);
		// The plugin stops before answering: no answer.
		await host!.stopPlugin("ledger");
		await until(() => settled.find((e) => e.id === id));
		journal.flush();
		expect(lines(journalFile).map((e) => [e.name, e.outcome, e.error])).toEqual([
			["open-link", "ok", undefined],
			["skip", "not-handled", undefined],
			["fail", "error", "it broke"],
			["stall", "no-answer", "the plugin stopped before answering"],
		]);
	});

	test("entries never hold text, field values, row titles or result data", async () => {
		const { journal, journalFile, send } = await start();
		const done = await send("done", { rowId: "r1" });
		expect(done.data).toEqual({ token: "PLUGIN-DATA-PRIVATE" });
		await send("field", { form: "pane", field: "note", value: "TYPED-VALUE-PRIVATE", rowId: "r1" });
		await send("field", { form: "prefs", field: "theme", value: "TYPED-THEME-PRIVATE" });
		await send("search", { query: "SEARCH-PRIVATE" });
		journal.flush();
		const text = readFileSync(journalFile, "utf8");
		expect(lines(journalFile)).toHaveLength(3);
		for (const secret of ["PLUGIN-DATA-PRIVATE", "TYPED-VALUE-PRIVATE", "TYPED-THEME-PRIVATE", "SEARCH-PRIVATE", "Secret title one", "Private title two", "value", "data", "title"])
			expect(text).not.toContain(secret);
	});

	test("a journal that can't be written never holds up an event", async () => {
		const profile = temp("toolbelt-journal-ro-");
		// Its folder is a file: nothing can be created under it.
		writeFileSync(join(profile, "journal"), "");
		const { journal, send } = await start(join(profile, "journal/changes.jsonl"));
		const done = await send("done", { rowId: "r1" });
		expect(done).toMatchObject({ outcome: "ok", data: { token: "PLUGIN-DATA-PRIVATE" } });
		expect((await send("purge", { rowId: "r2" })).outcome).toBe("ok");
		expect(journal.status()).toMatchObject({ writable: false, dropped: 2, entries: 0 });
		expect(journal.status().error).toBeString();
		// The plugin keeps working.
		expect((await send("open-link", {})).outcome).toBe("ok");
	});

	test("removing a plugin keeps its entries", async () => {
		const { profile, journal, journalFile, send } = await start();
		await send("done", { rowId: "r1" });
		await host!.stopPlugin("ledger");
		host!.remove("ledger");
		rmSync(join(profile, "data/ledger"), { recursive: true, force: true });
		host = undefined;
		journal.flush();
		expect(lines(journalFile).map((e) => [e.plugin, e.name])).toEqual([["ledger", "done"]]);
		expect(verifyJournal(journalFile).breakCount).toBe(0);
	});
});

test("the package manager removing a plugin and its data leaves the journal alone", async () => {
	const root = temp("toolbelt-journal-remove-");
	const source = temp("toolbelt-journal-package-");
	const manifest = {
		formatVersion: 1, id: "fixture", name: "Fixture", version: "1.0.0", repo: "test/fixture", entry: "index.js", protocol: 3, agent: { access: "read" }, icon: "box",
		screens: [{ id: "main", title: "Main" }], requires: { host: ">=0.1.0", bun: ">=1.3.0", platforms: ["portable"] }, capabilities: { required: ["ui.core"], optional: [] }, data: { schema: 1 },
	};
	writeFileSync(join(source, "toolbelt.json"), JSON.stringify(manifest));
	writeFileSync(join(source, "index.js"), "");
	const tar = Bun.spawn(["tar", "--format", "ustar", "-czf", join(source, "package.tgz"), "-C", source, "toolbelt.json", "index.js"]);
	expect(await tar.exited).toBe(0);
	const bytes = new Uint8Array(await Bun.file(join(source, "package.tgz")).arrayBuffer());
	const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const manager = new PackageManager(root, { prepare: async () => {}, stop: async () => {}, probe: async () => {}, activate: async () => {}, remove: () => {} }, "0.1.0");
	await manager.install(await manager.stage(bytes, hash, "test/fixture"), true);
	const file = join(root, "journal/changes.jsonl");
	const journal = new ChangeJournal(file, { log: () => {} });
	journal.record(settledEvent({ plugin: "fixture" }));
	journal.flush();
	const before = readFileSync(file, "utf8");
	await manager.remove("fixture", true);
	expect(existsSync(join(root, "data/fixture"))).toBe(false);
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(verifyJournal(file)).toMatchObject({ entries: 1, breakCount: 0 });
});

const WINDOW: Actor = { kind: "person", via: "window" };
let nextId = 0;
/** A settled event as the host reports it. */
function settledEvent(o: { plugin?: string; name?: string; field?: string; rows?: string[]; actor?: Actor; outcome?: EventSettled["outcome"]; error?: string; at?: number; approval?: "none" | "grant" | "once" } = {}): EventSettled {
	const field = o.field !== undefined;
	return {
		id: `e${++nextId}`,
		plugin: o.plugin ?? "p",
		surface: "screen:main",
		name: field ? "field" : (o.name ?? "done"),
		actor: o.actor ?? WINDOW,
		outcome: o.outcome ?? "ok",
		...(o.error ? { error: o.error } : {}),
		change: { name: field ? o.field! : (o.name ?? "done"), effect: "write", rows: o.rows ?? [], at: o.at ?? Date.now(), ...(o.approval ? { approval: o.approval } : {}) },
	};
}

describe("coalescing field entries", () => {
	const journalWith = () => {
		const file = join(temp("toolbelt-journal-unit-"), "journal/changes.jsonl");
		return { file, journal: new ChangeJournal(file, { log: () => {} }) };
	};

	test("the first event's id and time, the latest error; a different outcome starts a new entry", () => {
		const { file, journal } = journalWith();
		const t = Date.now();
		const a = settledEvent({ field: "f.x", rows: ["r"], at: t, outcome: "error", error: "first" });
		journal.record(a);
		journal.record(settledEvent({ field: "f.x", rows: ["r"], at: t + 3000, outcome: "error", error: "latest" }));
		journal.record(settledEvent({ field: "f.x", rows: ["r"], at: t + 4000 }));
		journal.flush();
		expect(lines(file).map((e) => [e.event, e.at, e.outcome, e.error])).toEqual([
			[a.id, t, "error", "latest"],
			[`e${nextId}`, t + 4000, "ok", undefined],
		]);
	});

	test("10 s from the entry's first event, another entry in between, or another field ends it", () => {
		const { file, journal } = journalWith();
		const t = Date.now();
		journal.record(settledEvent({ field: "f.x", at: t }));
		journal.record(settledEvent({ field: "f.x", at: t + 10_000 })); // joins: within 10 s
		journal.record(settledEvent({ field: "f.x", at: t + 10_001 })); // too late
		journal.record(settledEvent({ name: "done" }));
		journal.record(settledEvent({ field: "f.x", at: t + 10_002 })); // an entry came between
		journal.record(settledEvent({ field: "f.y", at: t + 10_003 }));
		journal.record(settledEvent({ field: "f.y", at: t + 10_004, actor: { kind: "person", via: "popover" } }));
		journal.flush();
		expect(lines(file).map((e) => e.name)).toEqual(["f.x", "f.x", "done", "f.x", "f.y", "f.y"]);
	});

	test("a held entry is written once its window closes", async () => {
		const file = join(temp("toolbelt-journal-unit-"), "journal/changes.jsonl");
		const journal = new ChangeJournal(file, { log: () => {}, coalesceMs: 50, syncMs: 10 });
		journal.record(settledEvent({ field: "f.x" }));
		expect(lines(file)).toEqual([]);
		await until(() => lines(file).length === 1, 2000);
	});

	test("an agent's entry carries its session, mode and approval", () => {
		const { file, journal } = journalWith();
		journal.record(settledEvent({ actor: { kind: "agent", client: "claude", session: "s1", mode: "interactive" }, approval: "once" }));
		journal.flush();
		expect(lines(file)[0]).toMatchObject({ actor: { kind: "agent", client: "claude", session: "s1", mode: "interactive" }, approval: "once" });
	});
});

describe("the hash chain", () => {
	/** A journal of `n` entries, written by ChangeJournal. */
	function written(n: number) {
		const file = join(temp("toolbelt-journal-chain-"), "journal/changes.jsonl");
		const journal = new ChangeJournal(file, { log: () => {} });
		for (let i = 0; i < n; i++) journal.record(settledEvent({ name: `a${i}`, rows: [`r${i}`] }));
		journal.close();
		return file;
	}
	const rewrite = (file: string, change: (lines: string[]) => string[]) => writeFileSync(file, change(readFileSync(file, "utf8").split("\n").filter(Boolean)).join("\n") + "\n");

	test("canonical form and hashes are deterministic", () => {
		expect(canonical({ b: 1, a: ["x", { d: "y", c: undefined, b: true }] })).toBe('{"a":["x",{"b":true,"d":"y"}],"b":1}');
		const file = written(2);
		const [one, two] = lines(file);
		const { hash, ...rest } = one;
		expect(hash).toBe(new Bun.CryptoHasher("sha256").update(GENESIS + canonical(rest)).digest("hex"));
		expect(two.hash).toBe(entryHash(one.hash, two));
		expect(verifyJournal(file)).toEqual({ entries: 2, last: { seq: 2, hash: two.hash }, breaks: [], breakCount: 0, endsTorn: false });
	});

	test("an edited entry is reported, and the chain goes on after it", () => {
		const file = written(4);
		rewrite(file, (l) => l.map((line, i) => (i === 1 ? line.replace('"r1"', '"r9"') : line)));
		const logs: string[] = [];
		const journal = new ChangeJournal(file, { log: (l) => logs.push(l) });
		expect(journal.status()).toMatchObject({ entries: 4, seq: 4, breakCount: 1, breaks: [{ line: 2, kind: "changed" }] });
		expect(logs[0]).toContain("line 2: changed");
		// The file isn't touched, and new entries keep chaining.
		journal.record(settledEvent());
		journal.flush();
		expect(verifyJournal(file)).toMatchObject({ entries: 5, breakCount: 1, last: { seq: 5 } });
	});

	test("an edit that recomputes the entry's hash shows at the next entry", () => {
		const file = written(3);
		rewrite(file, (l) =>
			l.map((line, i) => {
				if (i !== 1) return line;
				const e = JSON.parse(line);
				e.name = "other";
				return JSON.stringify({ ...e, hash: entryHash(JSON.parse(l[0]).hash, e) });
			}),
		);
		expect(verifyJournal(file).breaks).toEqual([{ line: 3, kind: "changed", detail: "entry 3 doesn't match the chain: it or the entry before it was changed" }]);
	});

	test("removed and moved lines are reported", () => {
		const removed = written(5);
		rewrite(removed, (l) => l.filter((_, i) => i !== 1 && i !== 2));
		expect(verifyJournal(removed).breaks).toEqual([{ line: 2, kind: "missing", detail: "entries 2–3 missing before entry 4" }]);
		const moved = written(4);
		rewrite(moved, (l) => [l[0], l[2], l[1], l[3]]);
		expect(verifyJournal(moved).breaks.map((b) => [b.line, b.kind])).toEqual([
			[2, "missing"],
			[3, "out-of-order"],
		]);
		const inserted = written(2);
		rewrite(inserted, (l) => [l[0], "not json", l[1]]);
		expect(verifyJournal(inserted).breaks.map((b) => [b.line, b.kind])).toEqual([[2, "torn"]]);
		const garbage = written(2);
		rewrite(garbage, (l) => [l[0], "not json", l[1].replace('"a1"', '"zz"')]);
		expect(verifyJournal(garbage).breaks.map((b) => [b.line, b.kind])).toEqual([
			[2, "unreadable"],
			[3, "changed"],
		]);
	});

	test("a torn last line is reported, kept, and the chain continues past it", () => {
		const file = written(3);
		const torn = lines(file)[2];
		// ToolBelt stopped halfway through writing a fourth entry.
		appendFileSync(file, JSON.stringify({ ...torn, seq: 4 }).slice(0, 40));
		const journal = new ChangeJournal(file, { log: () => {} });
		expect(journal.status()).toMatchObject({ entries: 3, seq: 3, breaks: [{ line: 4, kind: "torn", detail: "the last line is incomplete (ToolBelt may have stopped while writing it)" }] });
		journal.record(settledEvent({ name: "after" }));
		journal.flush();
		const text = readFileSync(file, "utf8").split("\n");
		expect(text[3]).toBe(JSON.stringify({ ...torn, seq: 4 }).slice(0, 40)); // never repaired
		expect(JSON.parse(text[4])).toMatchObject({ seq: 4, name: "after" });
		// The next start sees a write that didn't finish, followed by an unbroken chain.
		expect(verifyJournal(file)).toMatchObject({ entries: 4, breakCount: 1, breaks: [{ line: 4, kind: "torn", detail: "a write that didn't finish; the chain continues past it" }], endsTorn: false });
		expect(new ChangeJournal(file, { log: () => {} }).read(10).map((e) => e.seq)).toEqual([4, 3, 2, 1]);
	});

	test("a missing journal is an empty one", () => {
		const file = join(temp("toolbelt-journal-none-"), "journal/changes.jsonl");
		expect(new ChangeJournal(file).status()).toMatchObject({ entries: 0, seq: 0, breakCount: 0, writable: true, dropped: 0 });
		expect(new ChangeJournal(file).read()).toEqual([]);
	});
});
