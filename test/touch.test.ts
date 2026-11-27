import { describe, expect, test } from "bun:test";
import { DRAG_SLOP, dragFrame, edgeSwipe, EDGE_OPEN, EDGE_ZONE, FLING, FLING_MIN, holdStillEnough, HOLD_SLOP, PULL_SHARE, pullOffset, releaseVelocity, SCROLL_LOCK_MS, settle, sheetIntent, VELOCITY_WINDOW } from "../src/ui/lib/touch";

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

describe("sheet drag: what a touch becomes", () => {
	const base = { along: 0, across: 0, atTop: true, sinceScroll: Infinity, handle: false, canExpand: false };
	test("waits until it has moved far enough to tell", () => {
		expect(sheetIntent({ ...base, along: DRAG_SLOP - 1 })).toBe("wait");
		expect(sheetIntent({ ...base, along: -(DRAG_SLOP - 1) })).toBe("wait");
	});
	test("a pull down on content at its top, at rest, moves the sheet", () => {
		expect(sheetIntent({ ...base, along: DRAG_SLOP })).toBe("drag");
	});
	test("a pull down on scrolled content scrolls it back instead of closing", () => {
		expect(sheetIntent({ ...base, along: 40, atTop: false })).toBe("scroll");
	});
	test("content that just scrolled to its top (momentum) keeps the finger for a moment", () => {
		expect(sheetIntent({ ...base, along: 40, sinceScroll: 0 })).toBe("scroll");
		expect(sheetIntent({ ...base, along: 40, sinceScroll: SCROLL_LOCK_MS - 1 })).toBe("scroll");
		expect(sheetIntent({ ...base, along: 40, sinceScroll: SCROLL_LOCK_MS })).toBe("drag");
	});
	test("the grabber and header always move the sheet down", () => {
		expect(sheetIntent({ ...base, along: 40, atTop: false, sinceScroll: 0, handle: true })).toBe("drag");
	});
	test("up grows the sheet only from its handle, and only when it can grow", () => {
		expect(sheetIntent({ ...base, along: -40, handle: true, canExpand: true })).toBe("drag");
		expect(sheetIntent({ ...base, along: -40, handle: true, canExpand: false })).toBe("scroll");
		expect(sheetIntent({ ...base, along: -40, canExpand: true })).toBe("scroll");
	});
	test("a sideways move is a scroll", () => {
		expect(sheetIntent({ ...base, along: 8, across: 20 })).toBe("scroll");
		expect(sheetIntent({ ...base, along: 8, across: 20, handle: true })).toBe("scroll");
	});
});

describe("sheet drag: where it settles", () => {
	const one = [600];
	const two = [400, 800];
	test("a long enough pull closes a single-height sheet", () => {
		expect(settle(600 * PULL_SHARE, 0, one, 0)).toBe(-1);
		expect(settle(600 * PULL_SHARE - 1, 0, one, 0)).toBe(0);
	});
	test("a deliberate fling closes it however short the pull", () => {
		expect(settle(FLING_MIN, FLING, one, 0)).toBe(-1);
	});
	test("a fast flick of a few pixels (overscroll, momentum) doesn't", () => {
		expect(settle(FLING_MIN - 1, 3, one, 0)).toBe(0);
		expect(settle(FLING_MIN, FLING / 2, one, 0)).toBe(0);
	});
	test("a pull the other way never closes it", () => {
		expect(settle(-50, -2, one, 0)).toBe(0);
		expect(settle(0, 2, one, 0)).toBe(0);
	});
	test("two heights: a fling moves one step", () => {
		expect(settle(-FLING_MIN, -FLING, two, 0)).toBe(1);
		expect(settle(-FLING_MIN, -FLING, two, 1)).toBe(1);
		// Down from full goes to the smaller height, not closed, however hard.
		expect(settle(500, 3, two, 1)).toBe(0);
		expect(settle(FLING_MIN, FLING, two, 0)).toBe(-1);
	});
	test("two heights: a slow release goes to the nearest", () => {
		expect(settle(-150, 0, two, 0)).toBe(0);
		expect(settle(-250, 0, two, 0)).toBe(1);
		expect(settle(250, 0, two, 1)).toBe(0);
		expect(settle(150, 0, two, 1)).toBe(1);
	});
	test("two heights: closes only when pulled well below the smaller", () => {
		expect(settle(400 + 400 * PULL_SHARE, 0, two, 1)).toBe(-1);
		expect(settle(400 + 400 * PULL_SHARE - 1, 0, two, 1)).toBe(0);
		expect(settle(400 * PULL_SHARE, 0, two, 0)).toBe(-1);
	});
});

describe("sheet drag: release velocity", () => {
	test("is measured over the last moments of the drag", () => {
		const samples = [{ d: 0, t: 0 }, { d: 10, t: 900 }, { d: 60, t: 950 }, { d: 110, t: 1000 }];
		expect(releaseVelocity(samples, 1000)).toBe(1);
	});
	test("a finger that stopped before lifting has none", () => {
		expect(releaseVelocity([{ d: 0, t: 0 }, { d: 200, t: 50 }], 50 + VELOCITY_WINDOW + 1)).toBe(0);
		expect(releaseVelocity([{ d: 0, t: 0 }], 0)).toBe(0);
	});
});

describe("sheet drag: how the sheet follows", () => {
	test("a single-height sheet moves down freely, up with resistance", () => {
		expect(dragFrame(80, [600], 0)).toEqual({ height: 600, offset: 80 });
		expect(dragFrame(-100, [600], 0)).toEqual({ height: 600, offset: -20 });
	});
	test("two heights: it changes height between them, then moves", () => {
		expect(dragFrame(-100, [400, 800], 0)).toEqual({ height: 500, offset: 0 });
		expect(dragFrame(100, [400, 800], 1)).toEqual({ height: 700, offset: 0 });
		expect(dragFrame(500, [400, 800], 1)).toEqual({ height: 400, offset: 100 });
		expect(dragFrame(-500, [400, 800], 0)).toEqual({ height: 800, offset: -20 });
	});
});

describe("pull offset", () => {
	test("the sheet follows freely towards closing, with resistance the other way", () => {
		expect(pullOffset(80)).toBe(80);
		expect(pullOffset(-100)).toBe(-20);
		expect(Math.abs(pullOffset(-100))).toBeLessThan(100);
	});
});
