import { expect, test } from "bun:test";
import { editDistance, search } from "../src/sdk/search";

test("edit distance (with transpositions), capped", () => {
	expect(editDistance("codes", "codex")).toBe(1);
	expect(editDistance("cdoex", "codex")).toBe(1);
	expect(editDistance("vite", "vitest")).toBe(2);
	expect(editDistance("abc", "xyz")).toBe(2); // capped at max + 1
});

test("every word must match, as a substring or one typo away", () => {
	const s = search("codes web-app");
	expect(s.test(["codex", "~/orca/workspaces/web-app-starter"])).toBe(true);
	expect(s.test(["claude", "~/orca/workspaces/web-app-starter"])).toBe(false);
	expect(s.highlight().sort()).toEqual(["codes", "codex", "web-app"]);
});

test("partial pids and ports are substrings", () => {
	const s = search("504");
	expect(s.test(["bun run dev", 50493, ":3000"])).toBe(true);
	expect(search(":30").test([":3000"])).toBe(true);
});

test("short words need an exact substring; empty query matches everything", () => {
	expect(search("vit").test(["vote"])).toBe(false);
	expect(search("").test([])).toBe(true);
	expect(search("").highlight()).toEqual([]);
});

test("a typo of a word's beginning matches longer words", () => {
	const s = search("schedul");
	expect(s.test(["scheduler-12"])).toBe(true);
	expect(search("shedul").test(["scheduler-12"])).toBe(true);
});
