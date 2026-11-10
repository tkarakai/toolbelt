import { describe, expect, test } from "bun:test";
import type { Action, Column } from "../src/shared/protocol";
import { continuation, detailSections, fitColumns, groupActions, looksLikeScreen, nextZoom, visibleWidth } from "../src/ui/renderer/pure";
import { parseConversation } from "../plugins/processes/conversation";

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

describe("parseConversation", () => {
	test("Claude Code: typed messages, answers and tool calls; injected context skipped", () => {
		const lines = [
			{ type: "user", timestamp: "2026-11-09T10:00:00Z", message: { role: "user", content: "fix the build" } },
			{ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
			{ type: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Bash", input: { command: "bun test\nmore" } }] } },
			{ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
		].map((l) => JSON.stringify(l));
		const m = parseConversation(lines.join("\n") + "\nnot json", "claude");
		expect(m.map((x) => [x.role, x.text])).toEqual([
			["user", "fix the build"],
			["assistant", "On it."],
			["tool", "bun test"],
		]);
		expect(m[0].at).toBe(Date.parse("2026-11-09T10:00:00Z"));
		expect(m[1].author).toBe("claude");
		expect(m[2].tool?.name).toBe("Bash");
	});
	test("Codex", () => {
		const lines = [
			{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md stuff" }] } },
			{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
			{ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls", "-la"] }) } },
			{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
		].map((l) => JSON.stringify(l));
		expect(parseConversation(lines.join("\n"), "codex").map((x) => [x.role, x.text])).toEqual([
			["user", "hello"],
			["tool", "ls -la"],
			["assistant", "Done."],
		]);
	});
});
