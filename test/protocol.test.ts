import { describe, expect, test } from "bun:test";
import { defaultScreen, parseManifest, splitLines } from "../src/shared/protocol";

const base = { id: "demo", name: "Demo", protocol: 0, entry: "index.ts", screens: [{ id: "a", title: "A" }] };

describe("parseManifest", () => {
	test("fills defaults", () => {
		const m = parseManifest(base);
		expect(m.icon).toBe("box");
		expect(m.version).toBe("0.0.0");
	});

	test("rejects what Toolbelt can't use", () => {
		expect(() => parseManifest({ ...base, id: "Has Spaces" })).toThrow("`id`");
		expect(() => parseManifest({ ...base, protocol: 1 })).toThrow("`protocol` must be 0");
		expect(() => parseManifest({ ...base, screens: [] })).toThrow("at least one screen");
		expect(() => parseManifest({ ...base, entry: "" })).toThrow("`entry`");
		expect(() => parseManifest(null)).toThrow("not an object");
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
