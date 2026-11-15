import { expect, test } from "bun:test";
import { leavingRows, withLeaving, type Leaving } from "../src/ui/renderer/row-motion";

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
