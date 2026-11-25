import { describe, expect, test } from "bun:test";
import { HIDE_AFTER, nextChrome, REVEAL_TOP, SHOW_AFTER, type Chrome } from "../src/ui/lib/hide-on-scroll";

const shown: Chrome = { hidden: false, travel: 0 };
const hidden: Chrome = { hidden: true, travel: 0 };
const ROOM = 2000, BARS = 110;

describe("bars that slide away while scrolling", () => {
	test("hide once scrolled down far enough in one go", () => {
		let s = nextChrome(shown, 100, HIDE_AFTER - 4, ROOM, BARS);
		expect(s.hidden).toBe(false);
		s = nextChrome(s, 104, 4, ROOM, BARS);
		expect(s.hidden).toBe(true);
	});
	test("a change of direction starts counting again", () => {
		let s = nextChrome(shown, 100, 20, ROOM, BARS);
		s = nextChrome(s, 95, -5, ROOM, BARS);
		s = nextChrome(s, 115, 20, ROOM, BARS);
		expect(s.hidden).toBe(false);
	});
	test("come back soon after scrolling up", () => {
		expect(nextChrome(hidden, 500, -(SHOW_AFTER - 1), ROOM, BARS).hidden).toBe(true);
		expect(nextChrome(hidden, 500, -SHOW_AFTER, ROOM, BARS).hidden).toBe(false);
	});
	test("always show at the top", () => {
		expect(nextChrome(hidden, REVEAL_TOP, 40, ROOM, BARS)).toEqual(shown);
	});
	test("content with little to scroll keeps them", () => {
		expect(nextChrome(shown, 100, 60, BARS * 2 - 1, BARS).hidden).toBe(false);
		// Once hidden, the content's grown height doesn't bring them back by itself.
		expect(nextChrome(hidden, 100, 10, BARS, BARS).hidden).toBe(true);
	});
	test("a scroll that doesn't move vertically changes nothing", () => {
		const s = { hidden: false, travel: 10 };
		expect(nextChrome(s, 100, 0, ROOM, BARS)).toBe(s);
	});
});
