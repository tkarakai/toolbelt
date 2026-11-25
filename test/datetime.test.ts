import { describe, expect, test } from "bun:test";
import { addMonths, defaultPresets, join, monthGrid, moveFocus, parseInput, parseTime, relativeDay, split } from "../src/ui/renderer/datetime";

// Sunday, November 15, 2026.
const today = "2026-11-15";

describe("parseTime", () => {
	test.each([
		["9", "09:00"],
		["930", "09:30"],
		["9:30", "09:30"],
		["9.30", "09:30"],
		["2pm", "14:00"],
		["2:15 p.m.", "14:15"],
		["12am", "00:00"],
		["12pm", "12:00"],
		["14", "14:00"],
		["1430", "14:30"],
		["at 7", "07:00"],
		["noon", "12:00"],
		["midnight", "00:00"],
	])("%p → %p", (input, out) => expect(parseTime(input)).toBe(out));
	test.each(["", "25", "9:75", "13pm", "0am", "soon", "9:3"])("%p is unreadable", (input) => expect(parseTime(input)).toBeNull());
});

describe("parseInput", () => {
	test.each([
		["today", { date: today }],
		["tomorrow", { date: "2026-11-16" }],
		["tmr", { date: "2026-11-16" }],
		["yesterday", { date: "2026-11-14" }],
		["fri", { date: "2026-11-20" }],
		["Friday", { date: "2026-11-20" }],
		["sun", { date: today }],
		["next fri", { date: "2026-11-27" }],
		["next week", { date: "2026-11-16" }],
		["weekend", { date: today }],
		["+3d", { date: "2026-11-18" }],
		["3d", { date: "2026-11-18" }],
		["in 2 weeks", { date: "2026-11-29" }],
		["in a week", { date: "2026-11-22" }],
		["+1m", { date: "2026-12-15" }],
		["end of month", { date: "2026-11-30" }],
		["nov 20", { date: "2026-11-20" }],
		["20 November", { date: "2026-11-20" }],
		["jan 3", { date: "2027-01-03" }],
		["nov 1", { date: "2027-11-01" }],
		["march 5, 2028", { date: "2028-03-05" }],
		["11/20", { date: "2026-11-20" }],
		["2/14/27", { date: "2027-02-14" }],
		["2026-12-01", { date: "2026-12-01" }],
		["20", { date: "2026-11-20" }],
		["10th", { date: "2026-12-10" }],
		["5pm", { date: today, time: "17:00" }],
		["fri 5pm", { date: "2026-11-20", time: "17:00" }],
		["tomorrow at 9:30", { date: "2026-11-16", time: "09:30" }],
		["nov 20 14:00", { date: "2026-11-20", time: "14:00" }],
		["2026-11-20 14:30", { date: "2026-11-20", time: "14:30" }],
		["2026-11-20T09:05", { date: "2026-11-20", time: "09:05" }],
	])("%p", (input, out) => expect(parseInput(input, today)).toEqual(out));
	test.each(["", "someday", "feb 30 2027", "2026-02-30", "13/40", "fri 25:00"])("%p is unreadable", (input) => expect(parseInput(input, today)).toBeNull());
	test.each([
		["3d ago", { date: "2026-11-12" }],
		["-2w", { date: "2026-11-01" }],
		["a month ago", { date: "2026-10-15" }],
		["last fri", { date: "2026-11-13" }],
		["last sun", { date: "2026-11-08" }],
	])("%p reads backwards in either direction", (input, out) => {
		expect(parseInput(input, today)).toEqual(out);
		expect(parseInput(input, today, true)).toEqual(out);
	});
	test("\"in 3d ago\" is unreadable", () => expect(parseInput("in 3d ago", today)).toBeNull());
	test.each([
		// Looking back (Activity's time range): the latest matching date up to today.
		["nov 20", { date: "2025-11-20" }, { date: "2026-11-20" }],
		["nov 10 9am", { date: "2026-11-10", time: "09:00" }, { date: "2027-11-10", time: "09:00" }],
		["dec 1", { date: "2025-12-01" }, { date: "2026-12-01" }],
		["fri", { date: "2026-11-13" }, { date: "2026-11-20" }],
		["sun", { date: "2026-11-15" }, { date: "2026-11-15" }],
		["20", { date: "2026-10-20" }, { date: "2026-11-20" }],
		["11/20", { date: "2025-11-20" }, { date: "2026-11-20" }],
		["+3d", { date: "2026-11-18" }, { date: "2026-11-18" }],
	])("%p looking back and ahead", (input, back, ahead) => {
		expect(parseInput(input, today, true)).toEqual(back);
		expect(parseInput(input, today)).toEqual(ahead);
	});
});

describe("values, grid and wording", () => {
	test("split and join round-trip, dropping the time for date-only fields", () => {
		expect(split("")).toBeNull();
		expect(split("2026-11-20T09:00")).toEqual({ date: "2026-11-20", time: "09:00" });
		expect(join({ date: "2026-11-20", time: "09:00" })).toBe("2026-11-20T09:00");
		expect(join({ date: "2026-11-20", time: "09:00" }, false)).toBe("2026-11-20");
		expect(join(null)).toBe("");
	});
	test("months clamp to their last day", () => {
		expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
		expect(addMonths("2026-11-15", -12)).toBe("2025-11-15");
	});
	test("the grid starts on the week's first day and covers six weeks", () => {
		const sunday = monthGrid(today, 0);
		expect(sunday).toHaveLength(42);
		expect(sunday[0]).toBe("2026-11-01");
		const monday = monthGrid(today, 1);
		expect(monday[0]).toBe("2026-10-26");
		expect(monday).toContain("2026-11-30");
	});
	test("keyboard moves", () => {
		expect(moveFocus(today, "ArrowRight", false, 0)).toBe("2026-11-16");
		expect(moveFocus(today, "ArrowUp", false, 0)).toBe("2026-11-08");
		expect(moveFocus(today, "PageDown", false, 0)).toBe("2026-12-15");
		expect(moveFocus(today, "PageUp", true, 0)).toBe("2025-11-15");
		expect(moveFocus("2026-11-18", "Home", false, 1)).toBe("2026-11-16");
		expect(moveFocus("2026-11-18", "End", false, 1)).toBe("2026-11-22");
		expect(moveFocus(today, "x", false, 0)).toBeNull();
	});
	test("relative days", () => {
		expect(relativeDay(today, today)).toBe("Today");
		expect(relativeDay("2026-11-16", today)).toBe("Tomorrow");
		expect(relativeDay("2026-11-20", today)).toBe("in 5 days");
		expect(relativeDay("2026-11-10", today)).toBe("5 days ago");
		expect(relativeDay("2026-12-06", today)).toBe("in 3 weeks");
		expect(relativeDay("2027-06-01", today)).toBeNull();
	});
	test("default presets", () => {
		expect(defaultPresets(today).map((p) => p.value)).toEqual([today, "2026-11-16", "2026-11-16", "2026-11-22"]);
	});
});
