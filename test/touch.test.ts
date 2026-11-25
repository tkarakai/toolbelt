import { describe, expect, test } from "bun:test";
import { dismisses, edgeSwipe, EDGE_OPEN, EDGE_ZONE, FLING, holdStillEnough, HOLD_SLOP, PULL_SHARE, pullOffset } from "../src/ui/lib/touch";

describe("long press", () => {
	test("a finger resting within the slop is still a long press", () => {
		expect(holdStillEnough(0, 0)).toBe(true);
		expect(holdStillEnough(HOLD_SLOP, 0)).toBe(true);
		expect(holdStillEnough(5, 5)).toBe(true);
	});
	test("drifting further is a scroll", () => {
		expect(holdStillEnough(HOLD_SLOP + 1, 0)).toBe(false);
		expect(holdStillEnough(0, -12)).toBe(false);
	});
});

describe("edge swipe", () => {
	test("only starts at the left edge", () => {
		expect(edgeSwipe(EDGE_ZONE + 1, 100, 0)).toBe("cancel");
		expect(edgeSwipe(0, 10, 0)).toBe("track");
	});
	test("opens once far enough and mostly sideways", () => {
		expect(edgeSwipe(4, EDGE_OPEN, 4)).toBe("open");
		expect(edgeSwipe(4, EDGE_OPEN - 1, 0)).toBe("track");
		// Far enough, but as much down as across: not decided yet.
		expect(edgeSwipe(4, EDGE_OPEN, EDGE_OPEN)).toBe("track");
	});
	test("a vertical or backwards move is a scroll", () => {
		expect(edgeSwipe(4, 10, 40)).toBe("cancel");
		expect(edgeSwipe(4, -10, 0)).toBe("cancel");
	});
});

describe("swipe to dismiss", () => {
	test("a long enough pull closes the sheet", () => {
		expect(dismisses(300 * PULL_SHARE, 0, 300)).toBe(true);
		expect(dismisses(300 * PULL_SHARE - 1, 0, 300)).toBe(false);
	});
	test("a fling closes it however short", () => {
		expect(dismisses(10, FLING, 300)).toBe(true);
		expect(dismisses(10, FLING / 2, 300)).toBe(false);
	});
	test("a pull the other way never closes it", () => {
		expect(dismisses(0, 2, 300)).toBe(false);
		expect(dismisses(-50, 2, 300)).toBe(false);
	});
	test("the sheet follows freely towards closing, with resistance the other way", () => {
		expect(pullOffset(80)).toBe(80);
		expect(pullOffset(-100)).toBe(-20);
		expect(Math.abs(pullOffset(-100))).toBeLessThan(100);
	});
});
