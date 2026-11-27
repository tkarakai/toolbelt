import { describe, expect, test } from "bun:test";
import { HUES, type Action, type Column } from "../src/shared/protocol";
import { actionForEvent, CHECK_WIDTH, INDENT, rowOffset, ROW_STEP, ROW_SLOT, actionForKey, menuActionForEvent, applyMove, formatKey, isToastKey, isNoopMove, keyNames, resolveDrop, rowSection, type DropSlot, withAlternatives, groupSummaryLayout, continuation, detailSections, dragBoundary, groupActions, hasBoundary, layoutColumns, looksLikeScreen, moveColumn, nextZoom, orderColumns, readSavedLayout, visibleWidth, leastUsedHue, moveItem, newOptionTexts, allowsSequence, arrangesFilters, atFilterDefault, FILTER_DIVIDER, filterSequence, placeFilter, sequenceArrangement, stepFilter, toggleFilterGroup, filterOptionGroups, splitMinutes, joinMinutes, stepMinutes, durationWords, cardOpen } from "../src/ui/renderer/pure";

const cols: Column[] = [
	{ key: "name", title: "Process", grow: true, minWidth: 260 },
	{ key: "ports", title: "Ports" },
	{ key: "cpu", title: "CPU" },
	{ key: "mem", title: "Memory" },
	{ key: "up", title: "Up" },
];
const content = () => 100;
const hidden = (c: Column[], available: number, opts: Parameters<typeof layoutColumns>[2] = {}) => [...layoutColumns(c, available, { content, ...opts }).hidden];
const set = (c: Column[], key: string, extra: Partial<Column>) => c.map((x) => (x.key === key ? { ...x, ...extra } : x));

describe("layoutColumns: what fits", () => {
	test("everything fits in a wide table", () => {
		expect(hidden(cols, 2000)).toEqual([]);
	});
	test("columns on the right give way first; the grow column never does", () => {
		expect(hidden(cols, 260 + 300)).toEqual(["up"]);
		expect(hidden(cols, 260 + 100)).toEqual(["up", "mem", "cpu"]);
		expect(hidden(cols, 10)).toEqual(["up", "mem", "cpu", "ports"]);
	});
	test("priority and optional override position", () => {
		const c = set(set(cols, "ports", { priority: 99 }), "up", { priority: 0 });
		expect(hidden(c, 260 + 300)).toEqual(["ports"]);
		expect(hidden(set(cols, "cpu", { optional: true }), 260 + 300)).toEqual(["cpu"]);
	});
	test("without a priority, the displayed order decides", () => {
		const moved = [cols[0], cols[4], cols[1], cols[2], cols[3]]; // Up dragged next to Process
		expect(hidden(moved, 260 + 300)).toEqual(["mem"]);
	});
	test("the fixed part (row actions) counts", () => {
		expect(hidden(cols, 260 + 400, { fixed: 80 })).toEqual(["up"]);
	});
	test("unknown width (before layout) hides nothing", () => {
		expect(layoutColumns(cols, Infinity, { content }).hidden.size).toBe(0);
	});
	test("scroll overflow keeps every column, wider than the window", () => {
		const l = layoutColumns(cols, 300, { content, overflow: "scroll" });
		expect(l.hidden.size).toBe(0);
		expect(l.total).toBe(260 + 400);
	});
});

describe("layoutColumns: widths", () => {
	const sized: Column[] = [
		{ key: "name", title: "Process", grow: true, minWidth: 280 },
		{ key: "ports", title: "Ports", width: 140 },
		{ key: "cpu", title: "CPU", width: 120 },
		{ key: "up", title: "Up", width: 72 },
	];
	test("only the growing column follows the window", () => {
		expect(layoutColumns(sized, 1000).widths).toEqual({ name: 668, ports: 140, cpu: 120, up: 72 });
		expect(layoutColumns(sized, 700).widths).toEqual({ name: 368, ports: 140, cpu: 120, up: 72 });
	});
	test("at its minimum, other columns hide instead of shrinking", () => {
		const l = layoutColumns(sized, 560);
		expect([...l.hidden]).toEqual(["up"]);
		expect(l.widths).toEqual({ name: 300, ports: 140, cpu: 120 });
	});
	test("a person's width replaces the default and is kept within the limits", () => {
		expect(layoutColumns(sized, 1000, { saved: { ports: 200 } }).widths.ports).toBe(200);
		expect(layoutColumns(set(sized, "ports", { maxWidth: 180 }), 1000, { saved: { ports: 500 } }).widths.ports).toBe(180);
		expect(layoutColumns(sized, 1000, { saved: { ports: 1 } }).widths.ports).toBe(40);
	});
	test("growing columns ignore saved widths", () => {
		expect(layoutColumns(sized, 1000, { saved: { name: 100 } }).widths.name).toBe(668);
	});
	test("weights share spare space; maxWidth caps a share", () => {
		const two: Column[] = [
			{ key: "name", title: "Name", grow: 2, minWidth: 100 },
			{ key: "path", title: "Path", grow: 1, minWidth: 100 },
		];
		expect(layoutColumns(two, 500).widths).toEqual({ name: 300, path: 200 });
		expect(layoutColumns(set(two, "name", { maxWidth: 200 }), 500).widths).toEqual({ name: 200, path: 300 });
	});
	test("shrinking columns give way before anything hides", () => {
		const c = set(sized, "ports", { shrink: 1, minWidth: 60 });
		const l = layoutColumns(c, 560);
		expect(l.hidden.size).toBe(0);
		expect(l.widths).toEqual({ name: 280, ports: 88, cpu: 120, up: 72 });
	});
	test("content-sized columns use their measured width", () => {
		const c = set(sized, "cpu", { width: "content" });
		expect(layoutColumns(c, 1000, { content: (x) => (x.key === "cpu" ? 90 : undefined) }).widths.cpu).toBe(90);
		expect(layoutColumns(c, 1000).widths.cpu).toBe(96);
	});
});

describe("dragging a column edge", () => {
	// Process grows on the left; the table fills its width (no spare room).
	const widths = { name: 500, ports: 100, cpu: 100, mem: 100, up: 100 };
	const at = (key: string) => cols.findIndex((c) => c.key === key);
	const total = (w: Record<string, number>) => Object.values(w).reduce((t, x) => t + x, 0);

	test("widening a column takes from its right-hand neighbour, so the edge follows the pointer", () => {
		const saved = dragBoundary(cols, widths, at("cpu"), 30);
		expect(saved).toEqual({ cpu: 130, mem: 70 });
		// Nothing to the left changes: the grower keeps its width when the layout is redone.
		const layout = layoutColumns(cols, total(widths) + 40, { saved: { ...widths, ...saved }, fixed: 40 });
		expect(layout.widths.name).toBe(500);
		expect(layout.widths.ports).toBe(100);
	});

	test("a neighbour at its minimum passes the cost to the next column", () => {
		expect(dragBoundary(cols, widths, at("ports"), 90)).toEqual({ ports: 190, cpu: 40, mem: 70 });
	});

	test("narrowing gives the room to the right-hand neighbour", () => {
		expect(dragBoundary(cols, widths, at("cpu"), -30)).toEqual({ cpu: 70, mem: 130 });
		expect(dragBoundary(cols, widths, at("cpu"), -90)).toEqual({ cpu: 40, mem: 160 });
	});

	test("a growing column's edge moves its neighbour; the grower takes what's left", () => {
		expect(dragBoundary(cols, widths, at("name"), 20)).toEqual({ ports: 80 });
		expect(dragBoundary(cols, widths, at("name"), -50)).toEqual({ ports: 150 });
		// Never below the grower's own minimum.
		expect(dragBoundary(cols, widths, at("name"), -400)).toEqual({ ports: 340 });
	});

	test("spare room after the last column is used before squeezing neighbours", () => {
		expect(dragBoundary(cols, widths, at("cpu"), 30, 20)).toEqual({ cpu: 130, mem: 90 });
		expect(dragBoundary(cols, widths, at("up"), 30, Infinity)).toEqual({ up: 130 });
	});

	test("the table's own edge is not a handle when a column grows to fill it", () => {
		expect(hasBoundary(cols, at("up"))).toBe(false);
		const fixed = cols.slice(1);
		expect(hasBoundary(fixed, fixed.length - 1)).toBe(true);
		expect(hasBoundary(cols, at("name"))).toBe(true);
		expect(hasBoundary(cols, at("cpu"))).toBe(true);
		expect(hasBoundary([{ key: "a", title: "A", resizable: false }, { key: "b", title: "B", resizable: false }], 0)).toBe(false);
	});
});

describe("column order", () => {
	test("the saved order applies; the first column stays put", () => {
		const o = orderColumns(cols, ["up", "ports", "name", "mem", "cpu"]);
		expect(o.map((c) => c.key)).toEqual(["name", "up", "ports", "mem", "cpu"]);
	});
	test("columns the plugin added go after their declared neighbour; removed ones are ignored", () => {
		const o = orderColumns(cols, ["mem", "gone", "ports"]);
		expect(o.map((c) => c.key)).toEqual(["name", "mem", "up", "ports", "cpu"]);
	});
	test("columns that can't move keep their declared slot", () => {
		const c = set(cols, "up", { reorderable: false });
		expect(orderColumns(c, ["mem", "cpu", "ports"]).map((x) => x.key)).toEqual(["name", "mem", "cpu", "ports", "up"]);
	});
	test("dropping before or after a column", () => {
		expect(moveColumn(cols, cols, "up", "ports", false)).toEqual(["up", "ports", "cpu", "mem"]);
		expect(moveColumn(cols, cols, "ports", "mem", true)).toEqual(["cpu", "mem", "ports", "up"]);
		expect(moveColumn(cols, cols, "ports", "name", false)).toEqual(["ports", "cpu", "mem", "up"]); // the first column isn't a target
	});
	test("a saved layout from storage keeps only well-formed parts", () => {
		expect(readSavedLayout({ widths: { a: 120, b: "x", c: -1, d: Infinity }, order: ["a", 3, "b"] })).toEqual({ widths: { a: 120 }, order: ["a", "b"] });
		expect(readSavedLayout("junk")).toEqual({ widths: {}, order: [] });
	});
});

describe("groupActions", () => {
	const a = (id: string, extra: Partial<Action> = {}): Action => ({ id, label: id, ...extra });
	test("by group, in order of first appearance", () => {
		const g = groupActions([a("focus", { group: "go" }), a("copy", { group: "cmd" }), a("peek", { group: "go" }), a("stop", { group: "stop", tone: "destructive" })]);
		expect(g.map((x) => x.map((y) => y.id))).toEqual([["focus", "peek"], ["copy"], ["stop"]]);
	});
	test("without groups, destructive actions go last, apart", () => {
		const g = groupActions([a("stop", { tone: "destructive" }), a("open"), a("copy")]);
		expect(g.map((x) => x.map((y) => y.id))).toEqual([["open", "copy"], ["stop"]]);
	});
});

test("detailSections keeps the order of first appearance", () => {
	const s = detailSections([
		{ label: "a", value: "1", section: "Command" },
		{ label: "b", value: "2", section: "Process" },
		{ label: "c", value: "3", section: "Command" },
		{ label: "d", value: "4" },
	]);
	expect(s.map((x) => [x.title, x.items.map((i) => i.label)])).toEqual([
		["Command", ["a", "c"]],
		["Process", ["b"]],
		[undefined, ["d"]],
	]);
});

describe("terminal", () => {
	test("continuation: appended lines, scrolled output, or a redraw", () => {
		expect(continuation(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
		expect(continuation(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["d", "e"]);
		expect(continuation(["a", "b"], ["a", "b"])).toEqual([]);
		expect(continuation(["a", "b"], ["x", "y"])).toBeNull();
		expect(continuation([], ["x"])).toBeNull();
	});
	test("visible width ignores escape codes", () => {
		expect(visibleWidth("\x1b[1;32mok\x1b[0m done")).toBe(7);
	});
	test("box drawing means a full-screen program", () => {
		expect(looksLikeScreen(["╭──╮", "│ a│"])).toBe(true);
		expect(looksLikeScreen(["plain", "log"])).toBe(false);
	});
});

test("nextZoom steps through the levels and resets", () => {
	expect(nextZoom(1, "zoomIn")).toBe(1.1);
	expect(nextZoom(1, "zoomOut")).toBe(0.9);
	expect(nextZoom(2, "zoomIn")).toBe(2);
	expect(nextZoom(0.75, "zoomOut")).toBe(0.75);
	expect(nextZoom(1.05, "zoomIn")).toBe(1.1);
	expect(nextZoom(1.75, "zoomReset")).toBe(1);
});


test("group summaries share column tracks through visibility and bulk selection changes", () => {
 expect(groupSummaryLayout(cols, "mem", false)).toEqual({index:3,labelSpan:3});
 expect(groupSummaryLayout(cols, "mem", true)).toEqual({index:3,labelSpan:4});
 expect(groupSummaryLayout(cols.filter(c=>c.key!=="cpu"), "mem", false)).toEqual({index:2,labelSpan:2});
 for (const key of ["mem", "unknown"]) expect(groupSummaryLayout(cols.filter(c=>c.key!=="mem"),key,false)).toEqual({index:-1,labelSpan:5});
 expect(groupSummaryLayout(cols,undefined,false)).toEqual({index:-1,labelSpan:6});
 expect(groupSummaryLayout(cols,"name",true)).toEqual({index:0,labelSpan:2});
});

describe("split-button alternatives", () => {
	const update: Action = { id: "update", label: "Update", key: "u", menu: [{ id: "review", label: "Review first", key: "r" }, { id: "terminal", label: "In Terminal", key: "t", disabled: true }] };
	test("follow their action in menu order", () => {
		expect(withAlternatives([update, { id: "pin", label: "Pin" }]).map((a) => a.id)).toEqual(["update", "review", "terminal", "pin"]);
	});
	test("answer their own shortcut keys, unless disabled", () => {
		expect(actionForKey([update], "U")?.id).toBe("update");
		expect(actionForKey([update], "r")?.id).toBe("review");
		expect(actionForKey([update], "t")).toBeUndefined();
	});
});

describe("modifier shortcuts", () => {
	const acts: Action[] = [
		{ id: "up", label: "Move up", key: "alt+up" },
		{ id: "snooze", label: "Snooze", key: "s" },
		{ id: "settle", label: "Settle", key: "shift+s" },
	];
	test("a key press matches its most specific shortcut", () => {
		expect(keyNames({ key: "ArrowUp", code: "ArrowUp", altKey: true })).toEqual(["alt+up"]);
		expect(keyNames({ key: "ß", code: "KeyS", altKey: true })).toEqual(["alt+s"]);
		expect(keyNames({ key: "S", code: "KeyS", shiftKey: true })).toEqual(["shift+s", "s"]);
		expect(actionForEvent(acts, { key: "ArrowUp", code: "ArrowUp", altKey: true })?.id).toBe("up");
		expect(actionForEvent(acts, { key: "S", code: "KeyS", shiftKey: true })?.id).toBe("settle");
		expect(actionForEvent(acts, { key: "s", code: "KeyS" })?.id).toBe("snooze");
		expect(actionForEvent(acts, { key: "ArrowUp", code: "ArrowUp" })).toBeUndefined();
		// Without a ⇧ shortcut, J still means j, as before.
		expect(actionForEvent([{ id: "j", label: "J", key: "j" }], { key: "J", code: "KeyJ", shiftKey: true })?.id).toBe("j");
	});
	test("inside an open menu, action keys run actions and other keys stay with the menu", () => {
		const menu: Action[] = [...acts, { id: "update", label: "Update", key: "u", menu: [{ id: "review", label: "Review first", key: "r" }, { id: "off", label: "Off", key: "o", disabled: true }] }];
		expect(menuActionForEvent(menu, { key: "s", code: "KeyS" })?.id).toBe("snooze");
		expect(menuActionForEvent(menu, { key: "S", code: "KeyS", shiftKey: true })?.id).toBe("settle");
		expect(menuActionForEvent(menu, { key: "ArrowUp", code: "ArrowUp", altKey: true })?.id).toBe("up");
		expect(menuActionForEvent(menu, { key: "r", code: "KeyR" })?.id).toBe("review");
		// Disabled actions, unknown letters, plain arrows, Enter, ⌘/⌃ and auto-repeat do nothing.
		expect(menuActionForEvent(menu, { key: "o", code: "KeyO" })).toBeUndefined();
		expect(menuActionForEvent(menu, { key: "x", code: "KeyX" })).toBeUndefined();
		expect(menuActionForEvent(menu, { key: "ArrowDown", code: "ArrowDown" })).toBeUndefined();
		expect(menuActionForEvent(menu, { key: "Enter", code: "Enter" })).toBeUndefined();
		expect(menuActionForEvent(menu, { key: "s", code: "KeyS", metaKey: true })).toBeUndefined();
		expect(menuActionForEvent(menu, { key: "s", code: "KeyS", ctrlKey: true })).toBeUndefined();
		expect(menuActionForEvent(menu, { key: "s", code: "KeyS", repeat: true })).toBeUndefined();
	});
	test("shortcuts are shown with symbols", () => {
		expect(formatKey("alt+up")).toBe("⌥↑");
		expect(formatKey("alt+shift+down")).toBe("⌥⇧↓");
		expect(formatKey("shift+s")).toBe("⇧S");
		expect(formatKey("j")).toBe("J");
		expect(formatKey("cmd+z")).toBe("⌘Z");
		expect(formatKey("cmd+shift+z")).toBe("⇧⌘Z");
	});
});

describe("dragging rows between sections", () => {
	const rows = [
		{ id: "a", cells: {}, group: "inbox" },
		{ id: "b", cells: {}, group: "inbox" },
		{ id: "c", cells: {}, group: "working" },
		{ id: "d", cells: {}, group: [{ id: "settled", label: "Settled" }] },
	];
	const sections = [
		{ id: "inbox", label: "Inbox" },
		{ id: "working", label: "Working" },
		{ id: "snoozed", label: "Snoozed", order: false as const },
		{ id: "settled", label: "Settled", order: "fixed" as const, dropLabel: "Settle" },
	];
	const slots: DropSlot[] = [
		{ kind: "header", section: "inbox" },
		{ kind: "row", id: "a", section: "inbox" },
		{ kind: "row", id: "b", section: "inbox" },
		{ kind: "header", section: "working" },
		{ kind: "row", id: "c", section: "working" },
		{ kind: "header", section: "snoozed" },
		{ kind: "header", section: "settled" },
		{ kind: "row", id: "d", section: "settled" },
	];
	test("rows know their section", () => {
		expect(rows.map((r) => rowSection(r))).toEqual(["inbox", "inbox", "working", "settled"]);
		expect(rowSection({ id: "x", cells: {} })).toBe("");
	});
	test("a drop lands before a row, after it, or at the top of a section", () => {
		expect(resolveDrop(slots, 2, false, sections, "c")).toEqual({ section: "inbox", before: "b", whole: false });
		expect(resolveDrop(slots, 2, true, sections, "c")).toEqual({ section: "inbox", before: null, whole: false });
		expect(resolveDrop(slots, 3, false, sections, "a")).toEqual({ section: "working", before: "c", whole: false });
		expect(resolveDrop(slots, 4, true, sections, "a")).toEqual({ section: "working", before: null, whole: false });
		// The dragged row itself is skipped when finding the next one.
		expect(resolveDrop(slots, 1, true, sections, "b")).toEqual({ section: "inbox", before: null, whole: false });
	});
	test("fixed sections take the row whole; refusing sections take nothing", () => {
		expect(resolveDrop(slots, 6, false, sections, "a")).toEqual({ section: "settled", before: null, whole: true });
		expect(resolveDrop(slots, 7, true, sections, "a")).toEqual({ section: "settled", before: null, whole: true });
		expect(resolveDrop(slots, 5, false, sections, "a")).toBeNull();
		expect(resolveDrop([{ kind: "other" }], 0, false, sections, "a")).toBeUndefined();
	});
	test("moves apply locally and no-op drops are recognized", () => {
		expect(applyMove(rows, { rowId: "c", section: "inbox", before: "a" }).map((r) => [r.id, rowSection(r)])).toEqual([["c", "inbox"], ["a", "inbox"], ["b", "inbox"], ["d", "settled"]]);
		expect(applyMove(rows, { rowId: "a", section: "working", before: null }).map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
		expect(applyMove(rows, { rowId: "a", section: "snoozed", before: null }).map((r) => [r.id, rowSection(r)]).at(-1)).toEqual(["a", "snoozed"]);
		expect(applyMove(rows, { rowId: "a", section: "settled", before: null }).find((r) => r.id === "a")!.group).toBe("settled");
		expect(isNoopMove(rows, { rowId: "a", section: "inbox", before: "b" })).toBe(true);
		expect(isNoopMove(rows, { rowId: "a", section: "inbox", before: "a" })).toBe(true);
		expect(isNoopMove(rows, { rowId: "b", section: "inbox", before: null })).toBe(true);
		expect(isNoopMove(rows, { rowId: "b", section: "inbox", before: "a" })).toBe(false);
		expect(isNoopMove(rows, { rowId: "a", section: "working", before: null })).toBe(false);
	});
});

describe("dragging rows into sub-sections", () => {
	const sections = [
		{ id: "inbox", label: "Inbox" },
		{ id: "progressing", label: "Progressing", sections: [
			{ id: "working", label: "Working" },
			{ id: "snoozed", label: "Snoozed", order: "fixed" as const, dropLabel: "Snooze" },
			{ id: "watching", label: "Watching", order: false as const },
		] },
		{ id: "settled", label: "Settled" },
	];
	const rows = [
		{ id: "a", cells: {}, group: "inbox" },
		{ id: "p", cells: {}, group: "progressing" },
		{ id: "w1", cells: {}, group: "working" },
		{ id: "w2", cells: {}, group: ["working", "Folder"] },
		{ id: "s", cells: {}, group: ["progressing", { id: "snoozed", label: "Snoozed" }] },
	];
	const slots: DropSlot[] = [
		{ kind: "header", section: "inbox" },
		{ kind: "row", id: "a", section: "inbox" },
		{ kind: "header", section: "progressing" },
		{ kind: "row", id: "p", section: "progressing" },
		{ kind: "header", section: "working" },
		{ kind: "row", id: "w1", section: "working" },
		{ kind: "other" },
		{ kind: "row", id: "w2", section: "working" },
		{ kind: "header", section: "snoozed" },
		{ kind: "row", id: "s", section: "snoozed" },
		{ kind: "header", section: "watching" },
		{ kind: "header", section: "settled" },
	];
	test("rows in a sub-section belong to it, by its id or a path through the parent", () => {
		expect(rows.map((r) => rowSection(r, sections))).toEqual(["inbox", "progressing", "working", "working", "snoozed"]);
		// Without the declaration, a group is only its top level.
		expect(rowSection(rows[2]!)).toBe("working");
		expect(rowSection(rows[4]!)).toBe("progressing");
	});
	test("drops name the sub-section, with the next row inside it", () => {
		expect(resolveDrop(slots, 4, false, sections, "a")).toEqual({ section: "working", before: "w1", whole: false });
		expect(resolveDrop(slots, 5, false, sections, "a")).toEqual({ section: "working", before: "w1", whole: false });
		expect(resolveDrop(slots, 7, true, sections, "a")).toEqual({ section: "working", before: null, whole: false });
		// The parent's own header and rows end before its first sub-section.
		expect(resolveDrop(slots, 2, false, sections, "a")).toEqual({ section: "progressing", before: "p", whole: false });
		expect(resolveDrop(slots, 3, true, sections, "a")).toEqual({ section: "progressing", before: null, whole: false });
		// Each sub-section takes drops by its own order.
		expect(resolveDrop(slots, 8, false, sections, "a")).toEqual({ section: "snoozed", before: null, whole: true });
		expect(resolveDrop(slots, 10, false, sections, "a")).toBeNull();
	});
	test("a move into a sub-section shows the row there until the plugin answers", () => {
		const moved = applyMove(rows, { rowId: "a", section: "working", before: "w2" }, sections);
		expect(moved.map((r) => [r.id, rowSection(r, sections)])).toEqual([["p", "progressing"], ["w1", "working"], ["a", "working"], ["w2", "working"], ["s", "snoozed"]]);
		expect(moved.find((r) => r.id === "a")!.group).toBe("working");
		// Groups inside the section move along; the section part changes.
		expect(applyMove(rows, { rowId: "w2", section: "snoozed", before: null }, sections).find((r) => r.id === "w2")!.group).toEqual(["snoozed", "Folder"]);
		expect(applyMove(rows, { rowId: "s", section: "progressing", before: null }, sections).map((r) => r.id)).toEqual(["a", "p", "s", "w1", "w2"]);
		expect(applyMove(rows, { rowId: "a", section: "watching", before: null }, sections).find((r) => r.id === "a")!.group).toBe("watching");
		expect(isNoopMove(rows, { rowId: "w1", section: "working", before: "w2" }, sections)).toBe(true);
		expect(isNoopMove(rows, { rowId: "w1", section: "progressing", before: null }, sections)).toBe(false);
		expect(isNoopMove(rows, { rowId: "s", section: "snoozed", before: null }, sections)).toBe(true);
	});
});

describe("nested sections at any depth", () => {
	// Project › Status, with Progressing's states one level further in: three declared levels.
	const sections = [
		{ id: "p:web", label: "Website", sections: [
			{ id: "p:web/inbox", label: "Inbox" },
			{ id: "p:web/progressing", label: "Progressing", sections: [
				{ id: "p:web/working", label: "Working" },
				{ id: "p:web/snoozed", label: "Snoozed", order: "fixed" as const },
			] },
		] },
		{ id: "p:none", label: "No Project" },
	];
	const rows = [
		{ id: "a", cells: {}, group: "p:web/inbox" },
		{ id: "b", cells: {}, group: "p:web/working" },
		{ id: "c", cells: {}, group: ["p:web/snoozed", "Folder"] },
		{ id: "d", cells: {}, group: ["p:web", "p:web/progressing", "p:web/working"] },
		{ id: "e", cells: {}, group: "p:none" },
	];
	test("a row belongs to its deepest declared section, by its id or a full path", () => {
		expect(rows.map((r) => rowSection(r, sections))).toEqual(["p:web/inbox", "p:web/working", "p:web/snoozed", "p:web/working", "p:none"]);
	});
	test("a move into a deep section keeps the groups inside it", () => {
		const moved = applyMove(rows, { rowId: "c", section: "p:web/working", before: "d" }, sections);
		expect(moved.find((r) => r.id === "c")!.group).toEqual(["p:web/working", "Folder"]);
		expect(moved.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(isNoopMove(rows, { rowId: "b", section: "p:web/working", before: "d" }, sections)).toBe(true);
		expect(isNoopMove(rows, { rowId: "a", section: "p:web/progressing", before: null }, sections)).toBe(false);
	});
});

describe("arranged filters", () => {
	const filters = [
		{ id: "project", group: true },
		{ id: "status", group: true },
		{ id: "due", group: false },
		{ id: "priority", group: false, groupDisabled: "Up to 10 levels" },
	];
	const seq = filterSequence(filters);
	test("grouping filters come first, then the divider and the rest", () => {
		expect(seq).toEqual(["project", "status", FILTER_DIVIDER, "due", "priority"]);
		expect(sequenceArrangement(seq)).toEqual({ order: ["project", "status", "due", "priority"], grouped: ["project", "status"] });
		expect(arrangesFilters([{ id: "x", label: "X", options: [], selected: [] }])).toBe(false);
		expect(arrangesFilters([{ id: "x", label: "X", options: [], selected: [], group: false }])).toBe(true);
	});
	test("grouping on adds the last level; off puts the filter first among the rest", () => {
		expect(sequenceArrangement(toggleFilterGroup(seq, "due"))).toEqual({ order: ["project", "status", "due", "priority"], grouped: ["project", "status", "due"] });
		expect(sequenceArrangement(toggleFilterGroup(seq, "project"))).toEqual({ order: ["status", "project", "due", "priority"], grouped: ["status"] });
	});
	test("dragging and ⌥←/⌥→ move along the row; crossing the divider groups or ungroups", () => {
		expect(placeFilter(seq, "status", 0)).toEqual(["status", "project", FILTER_DIVIDER, "due", "priority"]);
		expect(placeFilter(seq, "project", 5)).toEqual(["status", FILTER_DIVIDER, "due", "priority", "project"]);
		expect(stepFilter(seq, "status", 1)).toEqual(["project", FILTER_DIVIDER, "status", "due", "priority"]);
		expect(stepFilter(seq, "due", -1)).toEqual(["project", "status", "due", FILTER_DIVIDER, "priority"]);
		expect(stepFilter(seq, "project", -1)).toEqual(seq);
	});
	test("a filter that can't group stays out of the grouping; one already grouping may stay", () => {
		expect(allowsSequence(filters, stepFilter(seq, "due", -1))).toBe(true);
		expect(allowsSequence(filters, placeFilter(seq, "priority", 0))).toBe(false);
		expect(allowsSequence([{ id: "a", group: true, groupDisabled: "No" }], ["a", FILTER_DIVIDER])).toBe(true);
	});
	test("a default selection matches in any order", () => {
		const f = { default: { values: ["inbox", "working"], label: "Ongoing" } };
		expect(atFilterDefault(f, ["working", "inbox"])).toBe(true);
		expect(atFilterDefault(f, ["inbox"])).toBe(false);
		expect(atFilterDefault({}, [])).toBe(false);
	});
});

test("a child's chevron starts where its parent's icon or title does, whatever the icon", () => {
	// One step: the parent's chevron (20) and its gap (8).
	expect(INDENT).toBe(28);
	// A group's rows put their chevron or unread slot one step in from the header's chevron.
	expect(rowOffset(0, false)).toBe(INDENT);
	expect(rowOffset(INDENT, false)).toBe(2 * INDENT);
	// With bulk actions the header spans the checkbox column and the row starts after it, so
	// the row moves back by that column: on screen it lands in the same place.
	expect(rowOffset(0, true) + CHECK_WIDTH).toBe(rowOffset(0, false));
	// It never goes back further than the first cell's 12px padding.
	expect(rowOffset(0, true)).toBeGreaterThanOrEqual(-12);
	// An expanded row's children start under its text. Without groups, rows start at the edge.
	expect(ROW_STEP).toBe(ROW_SLOT);
	expect(rowOffset(undefined, false)).toBe(0);
	expect(rowOffset(undefined, true)).toBe(0);
});

test("a toast button's ⌘ shortcut matches only its exact key press", () => {
	expect(isToastKey("cmd+z", { key: "z", code: "KeyZ", metaKey: true })).toBe(true);
	// The physical key, whatever the layout or ⌥ types.
	expect(isToastKey("cmd+z", { key: "y", code: "KeyZ", metaKey: true })).toBe(true);
	expect(isToastKey("cmd+z", { key: "z", code: "KeyZ" })).toBe(false);
	expect(isToastKey("cmd+z", { key: "z", code: "KeyZ", metaKey: true, shiftKey: true })).toBe(false);
	expect(isToastKey("cmd+z", { key: "z", code: "KeyZ", metaKey: true, altKey: true })).toBe(false);
	expect(isToastKey("cmd+z", { key: "z", code: "KeyZ", metaKey: true, ctrlKey: true })).toBe(false);
	expect(isToastKey("cmd+z", { key: "z", code: "KeyZ", metaKey: true, repeat: true })).toBe(false);
	expect(isToastKey("cmd+shift+z", { key: "Z", code: "KeyZ", metaKey: true, shiftKey: true })).toBe(true);
	expect(isToastKey("z", { key: "z", code: "KeyZ", metaKey: true })).toBe(false);
});

test("a text style colors, bolds and italicizes; its color wins over the tone", async () => {
	const { styleClass } = await import("../src/ui/renderer/colors");
	expect(styleClass(undefined)).toBe("");
	expect(styleClass({ bold: true, italic: true })).toBe("font-semibold italic");
	expect(styleClass({ color: "danger" }, "muted")).toContain("tb-tone-danger");
	expect(styleClass({ bold: true }, "muted")).toBe("text-muted-foreground tb-tone-muted font-semibold");
	expect(styleClass({ color: "violet" })).toContain("tb-tone-violet");
});

describe("options field", () => {
	test("new items take a color the list uses least, never a grey", () => {
		expect(leastUsedHue([], () => 0)).toBe("red");
		const all = HUES.filter((h) => h !== "slate" && h !== "stone");
		// Every color used once except teal: teal is the only least-used one.
		expect(leastUsedHue(all.filter((h) => h !== "teal"), () => 0.99)).toBe("teal");
		for (let i = 0; i < 50; i++) expect(["slate", "stone"]).not.toContain(leastUsedHue(["red"]));
	});
	test("a new color avoids the last item's neighbours on the wheel when it can", () => {
		for (let r = 0; r < 1; r += 0.05) expect(["red", "orange", "rose"]).not.toContain(leastUsedHue(["red"], () => r));
		// Only orange left unused, right after red: it's still chosen.
		const all = HUES.filter((h) => h !== "slate" && h !== "stone");
		expect(leastUsedHue([...all.filter((h) => h !== "orange"), "red"], () => 0)).toBe("orange");
	});
	test("moving and adding items", () => {
		expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
		expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
		expect(newOptionTexts(" High \n\nlow\nMedium\thigh", ["Low"])).toEqual(["High", "Medium"]);
	});
});

describe("filter option groups", () => {
	const o = (value: string, count: number, section?: string) => ({ value, label: value, count, ...(section !== undefined && { section }) });
	test("without sections: options with something to show, then those counted 0", () => {
		expect(filterOptionGroups([o("a", 1), o("b", 0), o("c", 2)]).map((g) => g.options.map((x) => x.value))).toEqual([["a", "c"], ["b"]]);
		expect(filterOptionGroups([o("a", 1)]).length).toBe(1);
	});
	test("with sections: the plugin's order, a group per run of the same section", () => {
		const groups = filterOptionGroups([o("inbox", 1), o("working", 0, "Progressing"), o("snoozed", 2, "Progressing"), o("settled", 0), o("archived", 0)]);
		expect(groups.map((g) => [g.section, g.options.map((x) => x.value)])).toEqual([
			[undefined, ["inbox"]],
			["Progressing", ["working", "snoozed"]],
			[undefined, ["settled", "archived"]],
		]);
	});
});

describe("durations", () => {
	test("minutes split into days, hours and minutes, and join back", () => {
		expect(splitMinutes(3 * 1440 + 4 * 60 + 30)).toEqual({ d: 3, h: 4, m: 30 });
		expect(joinMinutes({ d: 0, h: 36, m: 90 })).toBe(36 * 60 + 90);
		expect(splitMinutes(-5)).toEqual({ d: 0, h: 0, m: 0 });
	});
	test("a step carries into the next part and stays within bounds", () => {
		expect(stepMinutes(59, "m", 1)).toBe(60);
		expect(stepMinutes(23 * 60, "h", 1)).toBe(1440);
		expect(stepMinutes(30, "h", -1, 15)).toBe(15);
		expect(stepMinutes(1440, "d", 5, 0, 2880)).toBe(2880);
	});
	test("read aloud", () => {
		expect([durationWords(0), durationWords(1), durationWords(45), durationWords(90), durationWords(2 * 1440 + 240)]).toEqual(["0 minutes", "1 minute", "45 minutes", "1 hour 30 minutes", "2 days 4 hours"]);
	});
});

describe("cardOpen: a collapsible card's open state", () => {
	test("a card seen for the first time starts as the plugin says, closed by default", () => {
		expect(cardOpen(undefined, undefined)).toEqual({ open: false, seen: null });
		expect(cardOpen(null, true)).toEqual({ open: true, seen: true });
		expect(cardOpen(undefined, false)).toEqual({ open: false, seen: false });
	});
	test("the person's choice stands while the plugin's open stays the same", () => {
		const kept = { open: false, seen: true };
		expect(cardOpen(kept, true)).toBe(kept);
		const none = { open: true, seen: null };
		expect(cardOpen(none, undefined)).toBe(none);
	});
	test("a change of the plugin's open is followed", () => {
		expect(cardOpen({ open: false, seen: false }, true)).toEqual({ open: true, seen: true });
		expect(cardOpen({ open: true, seen: true }, false)).toEqual({ open: false, seen: false });
		// From no opinion to one: a check that failed points to the card.
		expect(cardOpen({ open: false, seen: null }, true)).toEqual({ open: true, seen: true });
	});
	test("dropping open changes nothing, so the next boolean opens it again", () => {
		const dropped = cardOpen({ open: false, seen: true }, undefined);
		expect(dropped).toEqual({ open: false, seen: null });
		expect(cardOpen(dropped, true)).toEqual({ open: true, seen: true });
	});
	test("a malformed saved state counts as unseen", () => {
		expect(cardOpen({ open: "yes", seen: true }, true)).toEqual({ open: true, seen: true });
		expect(cardOpen({ open: true, seen: 1 }, undefined)).toEqual({ open: false, seen: null });
		expect(cardOpen("open", undefined)).toEqual({ open: false, seen: null });
	});
});
