import { describe, expect, test } from "bun:test";
import { defaultScreen, floatingOnly, parseManifest, requireProtocol, splitLines } from "../src/shared/protocol";

const base = { id: "demo", name: "Demo", protocol: 3, agent: { access: "read" }, entry: "index.ts", screens: [{ id: "a", title: "A" }] };

describe("parseManifest", () => {
	test("fills defaults", () => {
		const m = parseManifest(base);
		expect(m.icon).toBe("box");
		expect(m.version).toBe("0.0.0");
	});

	test("rejects what Toolbelt can't use", () => {
		expect(() => parseManifest({ ...base, id: "Has Spaces" })).toThrow("`id`");
		expect(() => parseManifest({ ...base, protocol: "2" })).toThrow("`protocol` must be a whole number");
		expect(() => parseManifest({ ...base, screens: [] })).toThrow("at least one screen");
		expect(() => parseManifest({ ...base, entry: "" })).toThrow("`entry`");
		expect(() => parseManifest({ ...base, agent: undefined })).toThrow("`agent.access` is required");
		expect(() => parseManifest(null)).toThrow("not an object");
	});

	test("a manifest for another protocol parses, so its installation survives a ToolBelt update, and is refused by requireProtocol", () => {
		const old = parseManifest({ ...base, protocol: 1, agent: undefined });
		expect(old.protocol).toBe(1);
		expect(() => requireProtocol(old)).toThrow("Plugin needs an update: it was built for plugin protocol 1, and this ToolBelt speaks protocol 3");
		expect(() => requireProtocol(parseManifest(base))).not.toThrow();
		expect(() => parseManifest({ ...base, protocol: 1, agent: { access: "all" } })).toThrow("`agent.access`");
	});

	test("floating plugins: may have no screens, and take a ⌘ letter ToolBelt doesn't use", () => {
		const m = parseManifest({ ...base, screens: [], floating: { shortcut: "k" } });
		expect(m.floating).toEqual({ shortcut: "k" });
		expect(floatingOnly(m)).toBe(true);
		expect(floatingOnly(parseManifest({ ...base, floating: {} }))).toBe(false);
		expect(defaultScreen(m)).toBeUndefined();
		expect(() => parseManifest({ ...base, floating: { shortcut: "w" } })).toThrow("floating.shortcut");
		expect(() => parseManifest({ ...base, floating: { shortcut: "K" } })).toThrow("floating.shortcut");
		expect(() => parseManifest({ ...base, floating: true })).toThrow("`floating` must be an object");
	});

	test("default screen: the one marked default, else the first", () => {
		expect(defaultScreen(parseManifest(base))).toBe("a");
		expect(defaultScreen(parseManifest({ ...base, screens: [{ id: "a", title: "A" }, { id: "b", title: "B", default: true }] }))).toBe("b");
	});
});

describe("splitLines", () => {
	test("keeps the unfinished tail", () => {
		expect(splitLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' });
		expect(splitLines("\n\n  \n")).toEqual({ lines: [], rest: "" });
	});
});

test("screen shortcuts preserve explicit letters and reject ambiguous bindings", () => {
    expect(parseManifest({ ...base, screens: [{ id: "kept", title: "Kept", shortcut: "k" }] }).screens[0].shortcut).toBe("k");
    expect(() => parseManifest({ ...base, screens: [{ id: "a", title: "A", shortcut: "Cmd+A" }] })).toThrow("one lowercase letter");
    expect(() => parseManifest({ ...base, screens: [{ id: "a", title: "A", shortcut: "p" }, { id: "b", title: "B", shortcut: "p" }] })).toThrow("unique");
});
