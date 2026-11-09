import { expect, test } from "bun:test";
import { duration, refreshEvery, relative } from "../src/shared/time";

const now = Date.UTC(2026, 10, 9, 12, 0, 0);

test("duration: the two largest units", () => {
	expect(duration(0)).toBe("0s");
	expect(duration(45_000)).toBe("45s");
	expect(duration(5 * 60_000 + 59_000)).toBe("5m");
	expect(duration(2 * 3_600_000)).toBe("2h");
	expect(duration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
	expect(duration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
	expect(duration(-5)).toBe("0s");
});

test("relative: future, past, now, far away", () => {
	expect(relative(now + 2 * 3_600_000 + 14 * 60_000, now)).toBe("in 2h 14m");
	expect(relative(now - 5 * 60_000, now)).toBe("5m ago");
	expect(relative(now - 1000, now)).toBe("just now");
	expect(relative(now + 1000, now)).toBe("in a moment");
	expect(relative(now - 30 * 86_400_000, now)).not.toContain("ago");
});

test("refreshes every second within the hour, else every 30 s", () => {
	expect(refreshEvery(now + 59 * 60_000, now)).toBe(1000);
	expect(refreshEvery(now + 6 * 3_600_000, now)).toBe(30_000);
});
