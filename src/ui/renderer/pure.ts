// The renderer's pure parts — layout decisions and text helpers — kept free of React and the
// web view, so the tests can import them.
import type { Action, Column, DetailItem } from "../../shared/protocol";

/**
 * Actions in their groups (`Action.group`), groups in order of first appearance. Without any
 * groups, destructive actions still get a group of their own, after the rest.
 */
export function groupActions(actions: Action[]): Action[][] {
	if (!actions.some((a) => a.group)) {
		const safe = actions.filter((a) => a.tone !== "destructive");
		const risky = actions.filter((a) => a.tone === "destructive");
		return [safe, risky].filter((g) => g.length);
	}
	const groups = new Map<string, Action[]>();
	for (const a of actions) {
		const k = a.group ?? "";
		groups.set(k, [...(groups.get(k) ?? []), a]);
	}
	return [...groups.values()];
}

/**
 * Which columns fit: the `grow` column keeps at least its `minWidth`; the others give way in
 * priority order (highest `priority` first; by default the rightmost). Pure, for the tests.
 */
export function fitColumns(columns: Column[], available: number, widthOf: (c: Column) => number, fixed = 0): Set<string> {
	const hidden = new Set<string>();
	if (!Number.isFinite(available)) return hidden;
	const rank = (c: Column, i: number) => (c.priority ?? i) + (c.optional ? 1000 : 0);
	const candidates = columns
		.map((c, i) => ({ c, i, r: rank(c, i) }))
		.filter(({ c, i }) => !c.grow && i > 0)
		.sort((a, b) => b.r - a.r || b.i - a.i);
	const need = () => columns.reduce((t, c) => t + (hidden.has(c.key) ? 0 : c.grow ? (c.minWidth ?? 240) : widthOf(c)), fixed);
	for (const { c } of candidates) {
		if (need() <= available) break;
		hidden.add(c.key);
	}
	return hidden;
}

/** Details in their sections (`DetailItem.section`), in order of first appearance. */
export function detailSections(items: DetailItem[]): { title?: string; items: DetailItem[] }[] {
	const out: { title?: string; items: DetailItem[] }[] = [];
	for (const d of items) {
		let s = out.find((x) => x.title === d.section);
		if (!s) out.push((s = { title: d.section, items: [] }));
		s.items.push(d);
	}
	return out;
}

/** How `next` continues `prev`: the lines to append, or null when it doesn't (redraw). */
export function continuation(prev: string[], next: string[]): string[] | null {
	if (!prev.length) return null;
	// The longest suffix of `prev` that is a prefix of `next` (output scrolled up by k lines).
	for (let k = 0; k < prev.length; k++) {
		const n = prev.length - k;
		if (n > next.length) continue;
		let same = true;
		for (let i = 0; i < n; i++)
			if (prev[k + i] !== next[i]) {
				same = false;
				break;
			}
		if (same) return next.slice(n);
	}
	return null;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** Columns a line takes on screen (escape codes don't; wide characters are rare enough here). */
export const visibleWidth = (line: string) => line.replace(ANSI, "").replace(/\t/g, "        ").length;
/** Box drawing: a full-screen program's frame, which wrapping would tear apart. */
export const looksLikeScreen = (lines: string[]) => lines.some((l) => /[\u2500-\u257f]/.test(l));

export const ZOOM_STEPS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2];
export type ZoomCommand = "zoomIn" | "zoomOut" | "zoomReset";

export function nextZoom(current: number, cmd: ZoomCommand, steps = ZOOM_STEPS): number {
	if (cmd === "zoomReset") return 1;
	const i = steps.findIndex((s) => s >= current - 1e-6);
	const at = i < 0 ? steps.length - 1 : i;
	if (cmd === "zoomIn") return steps[Math.min(steps.length - 1, steps[at] > current + 1e-6 ? at : at + 1)];
	return steps[Math.max(0, at - 1)];
}


/** Shared table tracks for a group's label and optional column-bound summary. */
export function groupSummaryLayout(columns: Column[], column: string | undefined, bulk: boolean) {
 const index = column === undefined ? -1 : columns.findIndex(c => c.key === column);
 return { index, labelSpan: (index < 0 ? columns.length + 1 : Math.max(1, index)) + Number(bulk) };
}
