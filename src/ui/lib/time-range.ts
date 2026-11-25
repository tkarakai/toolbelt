// Time ranges for filters (Settings → Agents → Activity): quick ranges relative to now, or a
// From–To range of local dates and times. Pure, so tests can check them.

export const TIME_PRESETS = [
	{ id: "15m", label: "Last 15 minutes" },
	{ id: "1h", label: "Last hour" },
	{ id: "24h", label: "Last 24 hours" },
	{ id: "today", label: "Today" },
	{ id: "yesterday", label: "Yesterday" },
	{ id: "7d", label: "Last 7 days" },
	{ id: "30d", label: "Last 30 days" },
] as const;
export type TimePreset = (typeof TIME_PRESETS)[number]["id"];
/** No range, a quick range, or From–To as local `YYYY-MM-DD[THH:MM]` ("" for an open end). */
export type TimeRange = null | { preset: TimePreset } | { from: string; to: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A local date or date-time as epoch ms; a date alone is its first moment, or its last with `end`. */
export function localTime(value: string, end = false): number | undefined {
	const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
	if (!m) return undefined;
	const [, y, mo, d, h, mi] = m.map(Number);
	if (m[4] === undefined) return end ? new Date(y, mo - 1, d + 1).getTime() - 1 : new Date(y, mo - 1, d).getTime();
	// A time is a whole minute: To includes that minute.
	return new Date(y, mo - 1, d, h, mi).getTime() + (end ? MIN - 1 : 0);
}

/** The range's bounds in epoch ms, as of `now`. */
export function rangeBounds(range: TimeRange, now = Date.now()): { since?: number; until?: number } {
	if (!range) return {};
	if ("preset" in range) {
		const midnight = new Date(new Date(now).toDateString()).getTime();
		switch (range.preset) {
			case "15m":
				return { since: now - 15 * MIN };
			case "1h":
				return { since: now - HOUR };
			case "24h":
				return { since: now - DAY };
			case "today":
				return { since: midnight };
			case "yesterday":
				return { since: new Date(new Date(midnight - 1).toDateString()).getTime(), until: midnight - 1 };
			case "7d":
				return { since: now - 7 * DAY };
			case "30d":
				return { since: now - 30 * DAY };
		}
	}
	return { since: range.from ? localTime(range.from) : undefined, until: range.to ? localTime(range.to, true) : undefined };
}

const short = (value: string) => {
	const at = localTime(value);
	if (at === undefined) return value;
	const d = new Date(at);
	const date = d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
	return value.includes("T") ? `${date}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : date;
};

/** How the range reads on its button. */
export function rangeLabel(range: TimeRange): string | null {
	if (!range) return null;
	if ("preset" in range) return TIME_PRESETS.find((p) => p.id === range.preset)!.label;
	// One day: the date once ("Nov 20, 09:00 – 11:00").
	if (range.from && range.to && range.from.slice(0, 10) === range.to.slice(0, 10) && range.from.includes("T") && range.to.includes("T"))
		return `${short(range.from)} – ${new Date(localTime(range.to)!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	if (range.from && range.to) return range.from === range.to ? short(range.from) : `${short(range.from)} – ${short(range.to)}`;
	if (range.from) return `Since ${short(range.from)}`;
	if (range.to) return `Until ${short(range.to)}`;
	return null;
}
