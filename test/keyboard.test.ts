// The keyboard platform's pure rules (src/ui/lib/keys.ts) and the table's keyboard row move.
import { describe, expect, test } from "bun:test";
import { ariaShortcut, claims, nearestInDirection, resizeKey, stepIndex, widgetKeys } from "../src/ui/lib/keys";
import { keyboardMove, type DropSlot } from "../src/ui/renderer/pure";
import type { Section } from "../src/shared/protocol";

const press = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => ({ key, ...mods });

describe("widget keys", () => {
	test("text entry keeps typing keys, not Esc, Tab, F-keys or ⌘ shortcuts", () => {
		for (const w of [{ tag: "INPUT", type: "text" }, { tag: "INPUT", type: "search" }, { tag: "TEXTAREA" }, { tag: "DIV", editable: true }, { tag: "SELECT" }]) {
			const keys = widgetKeys(w);
			expect(claims(keys, press("a"))).toBe(true);
			expect(claims(keys, press("ArrowLeft"))).toBe(true);
			expect(claims(keys, press("Enter"))).toBe(true);
			expect(claims(keys, press("Escape"))).toBe(false);
			expect(claims(keys, press("Tab"))).toBe(false);
			expect(claims(keys, press("F6"))).toBe(false);
			expect(claims(keys, press("f", { metaKey: true }))).toBe(false);
		}
	});
	test("horizontal tabs keep ←/→, leaving ↑/↓ to the page", () => {
		const keys = widgetKeys({ tag: "BUTTON", role: "tab", orientation: "horizontal" });
		expect(claims(keys, press("ArrowLeft"))).toBe(true);
		expect(claims(keys, press("ArrowRight"))).toBe(true);
		expect(claims(keys, press("ArrowDown"))).toBe(false);
		const vertical = widgetKeys({ tag: "BUTTON", role: "tab", orientation: "vertical" });
		expect(claims(vertical, press("ArrowDown"))).toBe(true);
		expect(claims(vertical, press("ArrowLeft"))).toBe(false);
	});
	test("buttons keep only Enter and Space; checkboxes only Space", () => {
		const button = widgetKeys({ tag: "BUTTON" });
		expect(claims(button, press("Enter"))).toBe(true);
		expect(claims(button, press(" "))).toBe(true);
		expect(claims(button, press("ArrowDown"))).toBe(false);
		expect(claims(button, press("j"))).toBe(false);
		const box = widgetKeys({ tag: "INPUT", type: "checkbox" });
		expect(claims(box, press(" "))).toBe(true);
		expect(claims(box, press("Enter"))).toBe(false);
	});
	test("radio groups, menus, listboxes and separators keep their arrows", () => {
		expect(claims(widgetKeys({ tag: "BUTTON", role: "radio" }), press("ArrowRight"))).toBe(true);
		expect(claims(widgetKeys({ tag: "DIV", role: "menuitem" }), press("k"))).toBe(true);
		expect(claims(widgetKeys({ tag: "DIV", role: "option" }), press("ArrowDown"))).toBe(true);
		expect(claims(widgetKeys({ tag: "DIV", role: "separator" }), press("ArrowLeft"))).toBe(true);
		expect(claims(widgetKeys({ tag: "DIV", role: "separator" }), press("Enter"))).toBe(true);
	});
	test("⌥-arrows are row shortcuts, never widget navigation", () => {
		expect(claims(widgetKeys({ tag: "BUTTON", role: "tab" }), press("ArrowLeft", { altKey: true }))).toBe(false);
	});
	test("plain containers claim nothing", () => {
		expect(widgetKeys({ tag: "DIV" })).toEqual([]);
		expect(widgetKeys({ tag: "DIV", role: "region" })).toEqual([]);
	});
});

describe("moving through groups", () => {
	test("stepIndex clamps or loops, and enters at the near end", () => {
		expect(stepIndex(3, 0, "ArrowDown", "vertical")).toBe(1);
		expect(stepIndex(3, 2, "ArrowDown", "vertical")).toBe(2);
		expect(stepIndex(3, 2, "ArrowDown", "vertical", true)).toBe(0);
		expect(stepIndex(3, 0, "ArrowUp", "vertical", true)).toBe(2);
		expect(stepIndex(3, -1, "ArrowUp", "vertical")).toBe(2);
		expect(stepIndex(3, -1, "ArrowDown", "vertical")).toBe(0);
		expect(stepIndex(3, 1, "ArrowLeft", "vertical")).toBeNull();
		expect(stepIndex(3, 1, "ArrowLeft", "horizontal")).toBe(0);
		expect(stepIndex(3, 1, "End", "horizontal")).toBe(2);
		expect(stepIndex(0, 0, "ArrowDown", "vertical")).toBeNull();
	});
	test("nearestInDirection moves through a wrapping grid by rows and columns", () => {
		// 3 per row: 0 1 2 / 3 4 5 / 6
		const rects = Array.from({ length: 7 }, (_, i) => ({ left: (i % 3) * 100, top: Math.floor(i / 3) * 80, width: 90, height: 70 }));
		expect(nearestInDirection(rects, 0, "right")).toBe(1);
		expect(nearestInDirection(rects, 2, "right")).toBe(2);
		expect(nearestInDirection(rects, 1, "down")).toBe(4);
		expect(nearestInDirection(rects, 5, "down")).toBe(6);
		expect(nearestInDirection(rects, 6, "up")).toBe(3);
		expect(nearestInDirection(rects, 4, "left")).toBe(3);
		expect(nearestInDirection(rects, 0, "up")).toBe(0);
	});
	test("resizeKey grows toward its arrow and stops at the limits", () => {
		const limits = { min: 200, max: 400, step: 16, grows: "ArrowRight" as const };
		expect(resizeKey("ArrowRight", false, 240, limits)).toBe(256);
		expect(resizeKey("ArrowLeft", true, 240, limits)).toBe(200);
		expect(resizeKey("End", false, 240, limits)).toBe(400);
		expect(resizeKey("ArrowUp", false, 240, limits)).toBeNull();
		expect(resizeKey("ArrowLeft", false, 340, { min: 280, max: 720, grows: "ArrowLeft" })).toBe(356);
	});
});

test("ariaShortcut turns displayed and declared shortcuts into aria-keyshortcuts", () => {
	expect(ariaShortcut("⌘G")).toBe("Meta+G");
	expect(ariaShortcut("⌥⌘1")).toBe("Alt+Meta+1");
	expect(ariaShortcut("esc")).toBe("Escape");
	expect(ariaShortcut("↵")).toBe("Enter");
	expect(ariaShortcut("⌘↵")).toBe("Meta+Enter");
	expect(ariaShortcut("alt+up")).toBe("Alt+ArrowUp");
	expect(ariaShortcut("shift+j")).toBe("Shift+J");
	expect(ariaShortcut("p")).toBe("p");
	expect(ariaShortcut(".")).toBe(".");
	expect(ariaShortcut("+")).toBe("+");
});

describe("keyboard row move", () => {
	const header = (section: string): DropSlot => ({ kind: "header", section });
	const row = (id: string, section: string): DropSlot => ({ kind: "row", id, section });
	// Inbox: a b c · Done: d e · Later (no drops): f · Archive (fixed)
	const sections: Section[] = [{ id: "inbox", label: "Inbox" }, { id: "done", label: "Done" }, { id: "later", label: "Later", order: false }, { id: "archive", label: "Archive", order: "fixed" }];
	const slots = [header("inbox"), row("a", "inbox"), row("b", "inbox"), row("c", "inbox"), header("done"), row("d", "done"), row("e", "done"), header("later"), row("f", "later"), header("archive")];

	test("trades places inside a manual section", () => {
		expect(keyboardMove(slots, "b", "down", sections)).toEqual({ section: "inbox", before: null });
		expect(keyboardMove(slots, "a", "down", sections)).toEqual({ section: "inbox", before: "c" });
		expect(keyboardMove(slots, "b", "up", sections)).toEqual({ section: "inbox", before: "a" });
	});
	test("crosses into the neighboring section at its near end", () => {
		expect(keyboardMove(slots, "c", "down", sections)).toEqual({ section: "done", before: "d" });
		expect(keyboardMove(slots, "d", "up", sections)).toEqual({ section: "inbox", before: null });
	});
	test("passes over sections that refuse drops; fixed sections take the row whole", () => {
		expect(keyboardMove(slots, "e", "down", sections)).toEqual({ section: "archive", before: null });
		expect(keyboardMove(slots, "f", "up", sections)).toEqual({ section: "done", before: null });
	});
	test("has nowhere to go past the ends", () => {
		expect(keyboardMove(slots, "a", "up", sections)).toBeNull();
		expect(keyboardMove([header("inbox"), row("a", "inbox")], "a", "down", sections)).toBeNull();
	});
	test("skips nested rows and inner groups", () => {
		const nested = [header("inbox"), row("a", "inbox"), { kind: "other" } as DropSlot, row("b", "inbox")];
		expect(keyboardMove(nested, "a", "down", sections)).toEqual({ section: "inbox", before: null });
	});
});
