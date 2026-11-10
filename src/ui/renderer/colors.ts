// Colors for tones and hues (shared/protocol.ts): dots, text, pills. Written out in full so
// Tailwind sees every class. Hue shades: -700 text on light, -400 on dark; pills tint the
// background and use -800 / -300 text, which keeps them readable in every theme.
import type { Dot, Hue, Tone } from "../../shared/protocol";

const DOT: Record<Tone | Hue, string> = {
	default: "bg-foreground/40",
	muted: "bg-muted-foreground/40",
	success: "bg-emerald-500",
	warning: "bg-amber-500",
	danger: "bg-red-500",
	info: "bg-sky-500",
	red: "bg-red-500",
	orange: "bg-orange-500",
	amber: "bg-amber-500",
	yellow: "bg-yellow-400",
	lime: "bg-lime-400",
	green: "bg-green-500",
	emerald: "bg-emerald-500",
	teal: "bg-teal-500",
	cyan: "bg-cyan-500",
	sky: "bg-sky-500",
	blue: "bg-blue-500",
	indigo: "bg-indigo-500",
	violet: "bg-violet-500",
	purple: "bg-purple-500",
	fuchsia: "bg-fuchsia-500",
	pink: "bg-pink-500",
	rose: "bg-rose-500",
	slate: "bg-slate-500",
	stone: "bg-stone-500",
};

const DOT_DIM: Record<Tone | Hue, string> = {
	default: "bg-foreground/25",
	muted: "bg-muted-foreground/25",
	success: "bg-emerald-700 dark:bg-emerald-800",
	warning: "bg-amber-700 dark:bg-amber-800",
	danger: "bg-red-700 dark:bg-red-800",
	info: "bg-sky-700 dark:bg-sky-800",
	red: "bg-red-700 dark:bg-red-800",
	orange: "bg-orange-700 dark:bg-orange-800",
	amber: "bg-amber-700 dark:bg-amber-800",
	yellow: "bg-yellow-700 dark:bg-yellow-800",
	lime: "bg-lime-700 dark:bg-lime-800",
	green: "bg-green-700 dark:bg-green-800",
	emerald: "bg-emerald-700 dark:bg-emerald-800",
	teal: "bg-teal-700 dark:bg-teal-800",
	cyan: "bg-cyan-700 dark:bg-cyan-800",
	sky: "bg-sky-700 dark:bg-sky-800",
	blue: "bg-blue-700 dark:bg-blue-800",
	indigo: "bg-indigo-700 dark:bg-indigo-800",
	violet: "bg-violet-700 dark:bg-violet-800",
	purple: "bg-purple-700 dark:bg-purple-800",
	fuchsia: "bg-fuchsia-700 dark:bg-fuchsia-800",
	pink: "bg-pink-700 dark:bg-pink-800",
	rose: "bg-rose-700 dark:bg-rose-800",
	slate: "bg-slate-700 dark:bg-slate-800",
	stone: "bg-stone-700 dark:bg-stone-800",
};

const TEXT: Record<Tone | Hue, string> = {
	default: "",
	muted: "text-muted-foreground",
	success: "text-emerald-600 dark:text-emerald-400",
	warning: "text-amber-600 dark:text-amber-400",
	danger: "text-red-600 dark:text-red-400",
	info: "text-sky-600 dark:text-sky-400",
	red: "text-red-700 dark:text-red-400",
	orange: "text-orange-700 dark:text-orange-400",
	amber: "text-amber-700 dark:text-amber-400",
	yellow: "text-yellow-700 dark:text-yellow-400",
	lime: "text-lime-700 dark:text-lime-400",
	green: "text-green-700 dark:text-green-400",
	emerald: "text-emerald-700 dark:text-emerald-400",
	teal: "text-teal-700 dark:text-teal-400",
	cyan: "text-cyan-700 dark:text-cyan-400",
	sky: "text-sky-700 dark:text-sky-400",
	blue: "text-blue-700 dark:text-blue-400",
	indigo: "text-indigo-700 dark:text-indigo-400",
	violet: "text-violet-700 dark:text-violet-400",
	purple: "text-purple-700 dark:text-purple-400",
	fuchsia: "text-fuchsia-700 dark:text-fuchsia-400",
	pink: "text-pink-700 dark:text-pink-400",
	rose: "text-rose-700 dark:text-rose-400",
	slate: "text-slate-700 dark:text-slate-400",
	stone: "text-stone-700 dark:text-stone-400",
};

const PILL: Record<Tone | Hue, string> = {
	default: "bg-foreground/10 text-foreground",
	muted: "bg-muted text-muted-foreground",
	success: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
	warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
	danger: "bg-red-500/15 text-red-800 dark:text-red-300",
	info: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
	red: "bg-red-500/15 text-red-800 dark:bg-red-400/15 dark:text-red-300",
	orange: "bg-orange-500/15 text-orange-800 dark:bg-orange-400/15 dark:text-orange-300",
	amber: "bg-amber-500/15 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
	yellow: "bg-yellow-500/15 text-yellow-800 dark:bg-yellow-400/15 dark:text-yellow-300",
	lime: "bg-lime-500/15 text-lime-800 dark:bg-lime-400/15 dark:text-lime-300",
	green: "bg-green-500/15 text-green-800 dark:bg-green-400/15 dark:text-green-300",
	emerald: "bg-emerald-500/15 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
	teal: "bg-teal-500/15 text-teal-800 dark:bg-teal-400/15 dark:text-teal-300",
	cyan: "bg-cyan-500/15 text-cyan-800 dark:bg-cyan-400/15 dark:text-cyan-300",
	sky: "bg-sky-500/15 text-sky-800 dark:bg-sky-400/15 dark:text-sky-300",
	blue: "bg-blue-500/15 text-blue-800 dark:bg-blue-400/15 dark:text-blue-300",
	indigo: "bg-indigo-500/15 text-indigo-800 dark:bg-indigo-400/15 dark:text-indigo-300",
	violet: "bg-violet-500/15 text-violet-800 dark:bg-violet-400/15 dark:text-violet-300",
	purple: "bg-purple-500/15 text-purple-800 dark:bg-purple-400/15 dark:text-purple-300",
	fuchsia: "bg-fuchsia-500/15 text-fuchsia-800 dark:bg-fuchsia-400/15 dark:text-fuchsia-300",
	pink: "bg-pink-500/15 text-pink-800 dark:bg-pink-400/15 dark:text-pink-300",
	rose: "bg-rose-500/15 text-rose-800 dark:bg-rose-400/15 dark:text-rose-300",
	slate: "bg-slate-500/15 text-slate-800 dark:bg-slate-400/15 dark:text-slate-300",
	stone: "bg-stone-500/15 text-stone-800 dark:bg-stone-400/15 dark:text-stone-300",
};

export const dotClass = (c: Tone | Hue = "default", dim?: boolean) => (dim ? DOT_DIM : DOT)[c] ?? DOT.default;
export const textClass = (c: Tone | Hue = "default") => `${TEXT[c] ?? ""} tb-tone-${c}`;
export const pillClass = (c: Tone | Hue = "default") => `${PILL[c] ?? PILL.default} tb-pill-${c}`;

/** A `Dot` in one shape. */
export function dotSpec(d: Dot): { color: Tone | Hue; label?: string; pulse?: boolean; dim?: boolean } {
	return typeof d === "string" ? { color: d } : d;
}
