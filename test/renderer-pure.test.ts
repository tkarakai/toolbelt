import { describe, expect, test } from "bun:test";
import type { Action, Column } from "../src/shared/protocol";
import { groupSummaryLayout, continuation, detailSections, fitColumns, groupActions, looksLikeScreen, nextZoom, visibleWidth } from "../src/ui/renderer/pure";

const cols: Column[] = [
	{ key: "name", title: "Process", grow: true, minWidth: 260 },
	{ key: "ports", title: "Ports" },
	{ key: "cpu", title: "CPU" },
	{ key: "mem", title: "Memory" },
	{ key: "up", title: "Up" },
];
const width = () => 100;

describe("fitColumns", () => {
	test("everything fits in a wide table", () => {
		expect([...fitColumns(cols, 2000, width)]).toEqual([]);
	});
	test("columns on the right give way first; the grow column never does", () => {
		expect([...fitColumns(cols, 260 + 300, width)]).toEqual(["up"]);
		expect([...fitColumns(cols, 260 + 100, width)]).toEqual(["up", "mem", "cpu"]);
		expect([...fitColumns(cols, 10, width)]).toEqual(["up", "mem", "cpu", "ports"]);
	});
	test("priority and optional override position", () => {
		const c = cols.map((x) => (x.key === "ports" ? { ...x, priority: 99 } : x.key === "up" ? { ...x, priority: 0 } : x));
		expect([...fitColumns(c, 260 + 300, width)]).toEqual(["ports"]);
		const o = cols.map((x) => (x.key === "cpu" ? { ...x, optional: true } : x));
		expect([...fitColumns(o, 260 + 300, width)]).toEqual(["cpu"]);
	});
	test("the fixed part (row actions) counts", () => {
		expect([...fitColumns(cols, 260 + 400, width, 80)]).toEqual(["up"]);
	});
	test("unknown width (before layout) hides nothing", () => {
		expect(fitColumns(cols, Infinity, width).size).toBe(0);
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
