// How Toolbelt shows a moment (`at`, epoch ms): relative to now ("in 2h 14m", "5m ago") or as a
// compact stamp ("Mon 14:03").
// Shared by the renderer and plugins that want the same wording in plain text.

/** "2h 14m", "45s", "3d 4h": the two largest units. */
export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "in 2h 14m", "5m ago", "just now"; past a week, the date. */
export function relative(at: number, now = Date.now()): string {
	const diff = at - now;
	if (Math.abs(diff) < 5_000) return diff > 0 ? "in a moment" : "just now";
	if (Math.abs(diff) > 7 * 86_400_000) return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
	return diff > 0 ? `in ${duration(diff)}` : `${duration(-diff)} ago`;
}

/** How often a relative time needs redrawing to stay right. */
export const refreshEvery = (at: number, now = Date.now()) => (Math.abs(at - now) < 3_600_000 ? 1_000 : 30_000);

const startOfDay = (t: number) => {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * A message's time, as compact as still makes sense when a chat is reopened days later: "14:03"
 * today, "Mon 14:03" within the past week, "Nov 20, 14:03" earlier this year, else with the year.
 */
export function stamp(at: number, now = Date.now(), locale?: string): string {
	const d = new Date(at);
	// "2:03 PM" where the clock has 12 hours, "09:05" where it has 24.
	const h12 = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12;
	const time = d.toLocaleTimeString(locale, { hour: h12 ? "numeric" : "2-digit", minute: "2-digit" });
	const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
	if (days === 0) return time;
	if (days > 0 && days < 7) return `${d.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	return `${d.toLocaleDateString(locale, { month: "short", day: "numeric", ...(!sameYear && { year: "numeric" }) })}, ${time}`;
}

/** The full date and time: "Friday, November 20, 2026 at 2:03 PM". */
export const fullStamp = (at: number, locale?: string) => new Date(at).toLocaleString(locale, { dateStyle: "full", timeStyle: "short" });

/** When a stamp's wording next changes (the next midnight), in ms from now. */
export const stampRefresh = (now = Date.now()) => {
	const d = new Date(now);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - now + 1_000;
};
