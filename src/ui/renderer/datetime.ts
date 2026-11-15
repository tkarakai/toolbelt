// The date/time picker's logic, apart from React so it can be tested: reading what people type
// ("fri 5pm", "+3d", "nov 20", "2026-11-20 14:30"), reading times ("930", "2pm", "noon"), the
// month grid, presets and how a value is shown. Values are local wall-clock strings:
// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, never time-zone shifted.

export type Parts = { date: string; time?: string };

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toDate = (date: string) => {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(y!, m! - 1, d!);
};
export const addDays = (date: string, n: number) => {
	const d = toDate(date);
	d.setDate(d.getDate() + n);
	return isoDate(d);
};
/** Same day of month `n` months later, clamped to the month's last day (Jan 31 + 1 → Feb 28). */
export const addMonths = (date: string, n: number) => {
	const d = toDate(date);
	const day = d.getDate();
	const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
	const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
	return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(day, last)));
};

export function split(value: string): Parts | null {
	if (!value) return null;
	const [date, time] = value.split("T") as [string, string?];
	return time ? { date, time } : { date };
}
export const join = (p: Parts | null, withTime = true) => (!p ? "" : p.time && withTime ? `${p.date}T${p.time}` : p.date);

// ── reading typed times ─────────────────────────────────────────────────

/** "9" → 09:00, "930" → 09:30, "9:30", "9.30", "2pm", "2:15 p.m.", "14", "1430", "noon". Null when unreadable. */
export function parseTime(input: string): string | null {
	const t = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/\./g, (_m, i: number, s: string) => (/\d/.test(s[i - 1] ?? "") && /\d/.test(s[i + 1] ?? "") ? ":" : ""));
	if (!t) return null;
	if (t === "noon" || t === "midday") return "12:00";
	if (t === "midnight") return "00:00";
	const m = /^(?:at )?(\d{1,2})(?::?(\d{2}))?\s*(am?|pm?)?$/.exec(t);
	if (!m) return null;
	let h = Number(m[1]);
	const min = m[2] === undefined ? 0 : Number(m[2]);
	const half = m[3]?.[0];
	if (min > 59) return null;
	if (half) {
		if (h < 1 || h > 12) return null;
		h = (h % 12) + (half === "p" ? 12 : 0);
	} else if (h > 23) return null;
	return `${pad(h)}:${pad(min)}`;
}

// ── reading typed dates ─────────────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "fr", "fri", "fri.", "friday" → 5. Two letters already tell every weekday apart. */
const weekday = (word: string) => {
	const w = word.replace(/\.$/, "");
	return w.length >= 2 ? WEEKDAYS.findIndex((d) => d.startsWith(w)) : -1;
};
const month = (word: string) => {
	const w = word.replace(/\.$/, "");
	return w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1;
};
const realDate = (y: number, m: number, d: number) => {
	const date = new Date(y, m, d);
	return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? isoDate(date) : null;
};
/** The next date (today included) on day `d` of month `m`; this year if not past, else next. */
const nextOn = (today: string, m: number, d: number) => {
	const y = toDate(today).getFullYear();
	const here = realDate(y, m, d);
	return here && here >= today ? here : realDate(y + 1, m, d);
};

/** The date part alone: "today", "fri", "next fri", "+3d", "in 2 weeks", "nov 20", "11/20", "2026-11-20", "20". */
function parseDay(t: string, today: string): string | null {
	if (!t || t === "today" || t === "tod" || t === "now") return today;
	if (t === "tomorrow" || t === "tmr" || t === "tom" || t === "tmrw") return addDays(today, 1);
	if (t === "yesterday") return addDays(today, -1);
	if (t === "next week") return addDays(today, ((8 - toDate(today).getDay()) % 7) || 7);
	if (t === "next month") return addMonths(today, 1);
	if (t === "weekend" || t === "this weekend") {
		const dow = toDate(today).getDay();
		return dow === 6 || dow === 0 ? today : addDays(today, 6 - dow);
	}
	if (t === "end of month" || t === "eom") {
		const d = toDate(today);
		return isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
	}
	// Offsets: "+3d", "3d", "in 3 days", "2w", "+1m", "in a week".
	const off = /^(?:\+|in )?(\d+|an?) ?(d|day|days|w|wk|wks|week|weeks|m|mo|month|months|y|yr|year|years)$/.exec(t);
	if (off) {
		const n = off[1] === "a" || off[1] === "an" ? 1 : Number(off[1]);
		const u = off[2]![0];
		if (u === "d") return addDays(today, n);
		if (u === "w") return addDays(today, 7 * n);
		if (u === "m") return addMonths(today, n);
		return addMonths(today, 12 * n);
	}
	// Weekdays: "fri" is the next Friday (today counts), "next fri" the one after this week's.
	const wd = /^(next |this )?([a-z.]+)$/.exec(t);
	if (wd) {
		const dow = weekday(wd[2]!);
		if (dow >= 0) {
			const ahead = (dow - toDate(today).getDay() + 7) % 7;
			return addDays(today, wd[1] === "next " ? ahead + 7 : ahead);
		}
	}
	// ISO: 2026-11-20.
	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
	if (iso) return realDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
	// "nov 20", "november 20 2026", "20 nov", "20 november, 2026".
	const md = /^([a-z.]+) (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?$/.exec(t) ?? null;
	const dm = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z.]+),? ?(\d{4})?$/.exec(t) ?? null;
	const named = md ? { m: month(md[1]!), d: Number(md[2]), y: md[3] } : dm ? { m: month(dm[2]!), d: Number(dm[1]), y: dm[3] } : null;
	if (named && named.m >= 0) return named.y ? realDate(Number(named.y), named.m, named.d) : nextOn(today, named.m, named.d);
	// Numeric month/day ("11/20", "11/20/2026"), as written in the US.
	const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(t);
	if (slash) {
		const [m, d] = [Number(slash[1]) - 1, Number(slash[2])];
		if (!slash[3]) return nextOn(today, m, d);
		const y = slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
		return realDate(y, m, d);
	}
	// A day of the month alone: "20" is the next 20th.
	const dom = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
	if (dom) {
		const d = Number(dom[1]);
		const now = toDate(today);
		for (let i = 0; i < 12; i++) {
			const c = realDate(now.getFullYear(), now.getMonth() + i, d);
			if (c && c >= today) return c;
		}
	}
	return null;
}

/**
 * What a person typed, as a date with an optional time. A time alone means today at that time.
 * `today` is the local `YYYY-MM-DD`. Null when it can't be read.
 */
export function parseInput(input: string, today: string): Parts | null {
	const t = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/,$/, "");
	if (!t) return null;
	// ISO with a time: 2026-11-20T14:30 or 2026-11-20 14:30.
	const isoTime = /^(\d{4}-\d{1,2}-\d{1,2})[t ](.+)$/.exec(t);
	if (isoTime) {
		const date = parseDay(isoTime[1]!, today);
		const time = parseTime(isoTime[2]!);
		return date && time ? { date, time } : null;
	}
	const whole = parseDay(t, today);
	if (whole) return { date: whole };
	const time = parseTime(t);
	if (time) return { date: today, time };
	// A date followed by a time ("fri 5pm", "tomorrow at 9:30", "nov 20 14:00"): try each split.
	const words = t.split(" ");
	for (let i = words.length - 1; i > 0; i--) {
		const tail = words.slice(i).join(" ").replace(/^at /, "");
		const head = words.slice(0, i).join(" ").replace(/,$/, "").replace(/ at$/, "");
		const tm = parseTime(tail);
		if (!tm) continue;
		const date = parseDay(head, today);
		if (date) return { date, time: tm };
	}
	return null;
}

// ── the month grid ──────────────────────────────────────────────────────

/** The locale's first day of the week (0 Sunday … 6 Saturday). */
export function weekStart(locale?: string): number {
	try {
		const loc = new Intl.Locale(locale ?? navigator.language) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } };
		const first = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
		if (first) return first % 7;
	} catch {}
	return 0;
}

/** Six weeks of dates covering the month of `date` (`YYYY-MM-DD`), starting on `start`. */
export function monthGrid(date: string, start: number): string[] {
	const d = toDate(date);
	const first = new Date(d.getFullYear(), d.getMonth(), 1);
	const lead = (first.getDay() - start + 7) % 7;
	const origin = isoDate(new Date(first.getFullYear(), first.getMonth(), 1 - lead));
	return Array.from({ length: 42 }, (_, i) => addDays(origin, i));
}

export const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);

/** Moves keyboard focus in the grid: arrows by day/week, Page keys by month (with ⇧, year), Home/End to the week's ends. */
export function moveFocus(date: string, key: string, shift: boolean, start: number): string | null {
	switch (key) {
		case "ArrowLeft":
			return addDays(date, -1);
		case "ArrowRight":
			return addDays(date, 1);
		case "ArrowUp":
			return addDays(date, -7);
		case "ArrowDown":
			return addDays(date, 7);
		case "PageUp":
			return addMonths(date, shift ? -12 : -1);
		case "PageDown":
			return addMonths(date, shift ? 12 : 1);
		case "Home":
			return addDays(date, -((toDate(date).getDay() - start + 7) % 7));
		case "End":
			return addDays(date, 6 - ((toDate(date).getDay() - start + 7) % 7));
	}
	return null;
}

// ── presets and display ─────────────────────────────────────────────────

export type Preset = { label: string; value: string };

/** Today, Tomorrow, the coming Monday and a week from today (dates only). */
export function defaultPresets(today: string): Preset[] {
	return [
		{ label: "Today", value: today },
		{ label: "Tomorrow", value: addDays(today, 1) },
		{ label: "Next Monday", value: parseDay("next week", today)! },
		{ label: "In a week", value: addDays(today, 7) },
	];
}

/** "2:30 PM" or "14:30", as the locale writes times. */
export const formatTime = (time: string, locale?: string) => {
	const [h, m] = time.split(":").map(Number);
	return new Date(2000, 0, 1, h, m).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
};

/** "Fri, Nov 20" (this year) or "Fri, Nov 20, 2027", plus the time when there is one. */
export function formatValue(p: Parts, today: string, locale?: string): string {
	const d = toDate(p.date);
	const sameYear = d.getFullYear() === toDate(today).getFullYear();
	const day = d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", ...(!sameYear && { year: "numeric" }) });
	return p.time ? `${day} · ${formatTime(p.time, locale)}` : day;
}

/** "Today", "Tomorrow", "Yesterday", "in 5 days", "3 days ago", "in 2 weeks"; null past ~2 months. */
export function relativeDay(date: string, today: string): string | null {
	const days = Math.round((toDate(date).getTime() - toDate(today).getTime()) / 86_400_000);
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	const n = Math.abs(days);
	const span = n < 14 ? `${n} days` : n < 63 ? `${Math.round(n / 7)} weeks` : null;
	if (!span) return null;
	return days > 0 ? `in ${span}` : `${span} ago`;
}
