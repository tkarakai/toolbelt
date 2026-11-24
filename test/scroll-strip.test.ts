import { describe, expect, test } from "bun:test";
import { edgeScrollSpeed, revealScroll, stripEdges, stripStep, STRIP_EDGE } from "../src/ui/renderer/pure";

describe("stripEdges", () => {
	test("nothing hidden when the content fits", () => {
		expect(stripEdges(0, 500, 500)).toEqual({ left: false, right: false });
	});
	test("hidden on the right at the start, the left at the end, both between", () => {
		expect(stripEdges(0, 300, 800)).toEqual({ left: false, right: true });
		expect(stripEdges(500, 300, 800)).toEqual({ left: true, right: false });
		expect(stripEdges(200, 300, 800)).toEqual({ left: true, right: true });
	});
	test("a pixel of rounding doesn't count", () => {
		expect(stripEdges(0.5, 300, 800.5)).toEqual({ left: false, right: true });
		expect(stripEdges(499.5, 300, 800)).toEqual({ left: true, right: false });
	});
});

describe("stripStep", () => {
	test("most of the strip, never zero", () => {
		expect(stripStep(500)).toBe(400);
		expect(stripStep(0)).toBe(1);
	});
});

describe("revealScroll", () => {
	test("stays put when the item already shows clear of the fades", () => {
		expect(revealScroll(100, 300, 1000, 200, 300)).toBe(100);
	});
	test("scrolls right just enough to clear the right fade", () => {
		expect(revealScroll(0, 300, 1000, 350, 450)).toBe(450 - 300 + STRIP_EDGE);
	});
	test("scrolls left just enough to clear the left fade", () => {
		expect(revealScroll(400, 300, 1000, 380, 450)).toBe(380 - STRIP_EDGE);
	});
	test("an item wider than the strip shows its start", () => {
		expect(revealScroll(0, 100, 1000, 200, 500)).toBe(200 - STRIP_EDGE);
	});
	test("stays within the scroll range", () => {
		expect(revealScroll(300, 300, 400, 10, 50)).toBe(0);
		expect(revealScroll(0, 300, 400, 350, 400)).toBe(100);
	});
});

describe("edgeScrollSpeed", () => {
	test("still away from the edges", () => {
		expect(edgeScrollSpeed(200, 0, 400)).toBe(0);
	});
	test("leftward near the left edge, rightward near the right, faster closer", () => {
		expect(edgeScrollSpeed(40, 0, 400)).toBeLessThan(0);
		expect(edgeScrollSpeed(360, 0, 400)).toBeGreaterThan(0);
		expect(edgeScrollSpeed(390, 0, 400)).toBeGreaterThan(edgeScrollSpeed(360, 0, 400));
		expect(edgeScrollSpeed(-50, 0, 400)).toBe(-14);
	});
});
