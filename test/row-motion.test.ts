import { expect, test } from "bun:test";
import { changesView, leavingRows, slideFrom, withLeaving, type Leaving } from "../src/ui/renderer/row-motion";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string; leaving?: true }[]) => list.map((r) => (r.leaving ? `(${r.id})` : r.id));

test("a removed row stays where it was while it fades out; the rest keep the new order", () => {
	const leaving = leavingRows(rows("a", "b", "c", "d"), rows("d", "a", "c"), new Map(), 1);
	expect([...leaving.keys()]).toEqual(["b"]);
	expect(leaving.get("b")!.after).toBe("a");
	expect(ids(withLeaving(rows("d", "a", "c"), leaving))).toEqual(["d", "a", "(b)", "c"]);
});

test("removed rows at the top, and runs of them, keep their order", () => {
	const leaving = leavingRows(rows("a", "b", "c", "d", "e"), rows("c", "e"), new Map(), 1);
	expect(ids(withLeaving(rows("c", "e"), leaving))).toEqual(["(a)", "(b)", "c", "(d)", "e"]);
});

test("a row that comes back stops leaving; other leaving rows stay until they finish", () => {
	const first = leavingRows(rows("a", "b", "c"), rows("a", "c"), new Map(), 1);
	expect([...first.keys()]).toEqual(["b"]);
	const back = leavingRows(rows("a", "c"), rows("a", "b", "c"), first, 2);
	expect(back.size).toBe(0);
	const more = leavingRows(rows("a", "c"), rows("c"), first, 3);
	expect([...more.keys()].sort()).toEqual(["a", "b"]);
});

test("a whole different list doesn't animate its exits", () => {
	const before = rows(...Array.from({ length: 40 }, (_, i) => `r${i}`));
	expect(leavingRows(before, rows("x"), new Map(), 1).size).toBe(0);
	expect(withLeaving(rows("x"), new Map<string, Leaving<{ id: string }>>())).toEqual(rows("x"));
});

// An element inside the given ancestors, matched the way `closest` would.
const inside = (...matches: string[]) => ({ closest: (sel: string) => (sel.split(/,\s*/).some((s) => matches.includes(s)) ? {} : null) }) as unknown as Element;

test("changes of view (typing a search, filters, segmented controls) don't animate; moving rows does", () => {
	expect(changesView(inside("[data-view-control]"))).toBe(true);
	expect(changesView(inside("input:not([type=checkbox]):not([type=radio])"))).toBe(true);
	expect(changesView(inside("textarea"))).toBe(true);
	// Typing in a dialog then confirming moves a row (Snooze, a new task): that animates.
	expect(changesView(inside("textarea", "[role=dialog]"))).toBe(false);
	// A row, a checkbox, ⌥↑ on the table, an action button.
	expect(changesView(inside())).toBe(false);
	expect(changesView(null)).toBe(false);
});

test("an interrupted slide carries on from where the row is on screen", () => {
	// Laid out at 100, now at 140: it starts 40px up.
	expect(slideFrom(100, 140, 0)).toBe(-40);
	// Halfway through an earlier slide (drawn 20px lower than its old place), it starts there.
	expect(slideFrom(100, 140, 20)).toBe(-20);
	expect(slideFrom(140, 140, 0)).toBe(0);
});
