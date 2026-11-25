import { describe, expect, test } from "bun:test";
import { physicalKeyboardEvidence } from "../src/ui/lib/device";
import { backoff } from "../src/ui/lib/connection";

describe("physical keyboard evidence", () => {
	const key = (k: string, extra: Partial<Parameters<typeof physicalKeyboardEvidence>[0]> = {}) =>
		physicalKeyboardEvidence({ key: k, metaKey: false, ctrlKey: false, altKey: false, editable: false, ...extra });

	test("keys the on-screen keyboard can't type reveal key hints", () => {
		for (const k of ["Tab", "Escape", "ArrowDown", "PageUp", "F6"]) expect(key(k)).toBe(true);
		expect(key("c", { metaKey: true, editable: true })).toBe(true);
		expect(key("x", { altKey: true })).toBe(true);
	});

	test("typing letters, or anything in a text field, proves nothing", () => {
		expect(key("a")).toBe(false);
		expect(key("Enter")).toBe(false);
		expect(key("Tab", { editable: true })).toBe(false);
		expect(key("ArrowLeft", { editable: true })).toBe(false);
	});
});

describe("reconnect backoff", () => {
	test("doubles from a second, jittered between half and full, capped at 30 s", () => {
		expect(backoff(0, () => 1)).toBe(1000);
		expect(backoff(0, () => 0)).toBe(500);
		expect(backoff(3, () => 1)).toBe(8000);
		expect(backoff(10, () => 1)).toBe(30_000);
		expect(backoff(10, () => 0)).toBe(15_000);
	});
});

import { modalityForKey } from "../src/ui/lib/input-modality";

describe("input modality", () => {
	test("any real key means keyboard; a modifier held alone changes nothing", () => {
		for (const key of ["Tab", "ArrowDown", "Enter", "Escape", "a", "F6"]) expect(modalityForKey(key)).toBe("keyboard");
		for (const key of ["Meta", "Control", "Alt", "Shift", "CapsLock"]) expect(modalityForKey(key)).toBeNull();
	});
});
