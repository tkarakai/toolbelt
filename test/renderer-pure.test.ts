import { describe, expect, test } from "bun:test";
import type { Action, Column } from "../src/shared/protocol";
import { groupSummaryLayout, continuation, detailSections, groupActions, layoutColumns, looksLikeScreen, moveColumn, nextZoom, orderColumns, readSavedLayout, visibleWidth } from "../src/ui/renderer/pure";

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
