import { expect, test } from "bun:test";
import { duration, fullStamp, refreshEvery, relative, stamp, stampRefresh } from "../src/shared/time";

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

test("stamp: time today, weekday within a week, date earlier, year when not this year", () => {
	const at = (y: number, mo: number, d: number, h = 14, mi = 3) => new Date(y, mo, d, h, mi).getTime();
	const today = at(2026, 10, 27, 18, 0); // Fri Nov 27 2026, 18:00 local
	expect(stamp(at(2026, 10, 27, 0, 5), today, "en-GB")).toBe("00:05");
	expect(stamp(at(2026, 10, 26, 23, 59), today, "en-GB")).toBe("Thu 23:59");
	expect(stamp(at(2026, 10, 23), today, "en-US")).toBe("Mon 2:03 PM");
	expect(stamp(at(2026, 10, 20), today, "en-GB")).toBe("20 Nov, 14:03");
	expect(stamp(at(2026, 10, 20), today, "en-US")).toBe("Nov 20, 2:03 PM");
	expect(stamp(at(2025, 10, 20), today, "en-US")).toBe("Nov 20, 2025, 2:03 PM");
	// A clock a little ahead: a time later today is still today's.
	expect(stamp(at(2026, 10, 27, 18, 2), today, "en-GB")).toBe("18:02");
});

test("fullStamp names the day, date and time; stamps refresh after midnight", () => {
	expect(fullStamp(new Date(2026, 10, 20, 14, 3).getTime(), "en-US")).toBe("Friday, November 20, 2026 at 2:03 PM");
	const evening = new Date(2026, 10, 27, 23, 59, 0).getTime();
	expect(stampRefresh(evening)).toBe(61_000);
});
