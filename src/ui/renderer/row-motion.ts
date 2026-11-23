// Rows of a table, list or timeline that move: rows that leave fade out in place (EXIT_MS), new
// rows fade in (ENTER_MS) and the rest slide from where they were to where they are (MOVE_MS),
// whether a plugin's refresh or the person (a drop, ⌥↑/↓, expanding a group) moved them. Changes
// of view don't animate: sorting (the `context`), and refreshes that follow typing in a field or
// using a `data-view-control` (search, filters, segmented controls). Reduced motion and a list's
// first paint never animate.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

export const MOVE_MS = 300;
export const ENTER_MS = 300;
export const EXIT_MS = 200;
const EASE = "cubic-bezier(0.215, 0.61, 0.355, 1)";
/** A row fading in (with \`enterStyle\`) and a row the plugin removed, fading out in place
 *  before the rows around it close the gap (with \`leavingProps\`). */
export const ENTERING = "animate-in fade-in-0 slide-in-from-top-1";
export const LEAVING = "pointer-events-none animate-out fade-out-0 fill-mode-forwards";
export const enterStyle = { animationDuration: `${ENTER_MS}ms` } as const;
export const leavingProps = { "aria-hidden": true, "data-leaving": "", style: { animationDuration: `${EXIT_MS}ms` } } as const;
/** More rows than this leaving at once is a different list, not a refresh: no exit animation. */
const MAX_LEAVING = 30;
/** Refreshes arriving this soon after a change of view are that change, shown at once. */
const QUIET_MS = 600;
/** A row that's gone from the plugin's tree but still shown while it fades out. `after` is the
 *  row it followed (null: the top), so it stays where it was. */
export type Leaving<T> = { item: T; after: string | null; order: number };

/** The rows that left between two trees, each placed after the nearest earlier row still shown
 *  (or still leaving). Rows that came back stop leaving. */
export function leavingRows<T extends { id: string }>(prev: T[], next: T[], current: Map<string, Leaving<T>>, now: number): Map<string, Leaving<T>> {
	const nextIds = new Set(next.map((it) => it.id));
	const out = new Map([...current].filter(([id]) => !nextIds.has(id)));
	const gone = prev.filter((it) => !nextIds.has(it.id) && !out.has(it.id));
	if (!gone.length || gone.length + out.size > MAX_LEAVING) return gone.length ? new Map() : out;
	let after: string | null = null;
	prev.forEach((it, i) => {
		if (nextIds.has(it.id) || out.has(it.id)) after = it.id;
		if (!nextIds.has(it.id) && !out.has(it.id)) {
			out.set(it.id, { item: it, after, order: now + i / 1e4 });
			after = it.id;
		}
	});
	return out;
}

/** The rows to draw: the tree's rows with leaving rows back in their places. */
export function withLeaving<T extends { id: string }>(items: T[], leaving: Map<string, Leaving<T>>): (T & { leaving?: true })[] {
	if (!leaving.size) return items;
	const out: (T & { leaving?: true })[] = [...items];
	for (const l of [...leaving.values()].sort((a, b) => a.order - b.order)) {
		const at = l.after === null ? 0 : out.findIndex((it) => it.id === l.after) + 1;
		out.splice(at > 0 || l.after === null ? at : out.length, 0, { ...l.item, leaving: true });
	}
	return out;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Whether an event on `target` changes what a list shows rather than moving its rows: typing in
 * a field outside dialogs (a search), or a control marked `data-view-control` (filters,
 * segmented controls, sorting).
 */
export function changesView(target: Pick<Element, "closest"> | null): boolean {
	if (!target?.closest) return false;
	if (target.closest("[data-view-control]")) return true;
	return !!target.closest("input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]") && !target.closest("[role=dialog]");
}

/**
 * How far from its new place a row starts sliding: from where it was laid out (`was`), plus
 * where an unfinished slide had it (`current`), so an interrupted move carries on from where
 * the row is on screen instead of jumping.
 */
export const slideFrom = (was: number, now: number, current: number) => was + current - now;

/** The vertical translation an element has right now, mid-transition included. */
function currentShift(el: HTMLElement): number {
	// Only rows this hook slid can be mid-slide.
	if (!el.style.transition && !el.style.transform) return 0;
	const t = getComputedStyle(el).transform;
	if (!t || t === "none") return 0;
	const m = t.match(/^matrix\((.+)\)$/);
	return m ? Number(m[1]!.split(",")[5]) || 0 : 0;
}

export type Motion<T> = {
	/** The rows to draw: the list's rows with leaving rows back in their places. */
	rows: (T & { leaving?: true })[];
	/** Rows that just appeared, while they fade in (lists that don't track this themselves). */
	entering: Set<string>;
	/** A row was dropped at `clientY`: it slides from there into its place. */
	land: (id: string, clientY: number) => void;
};

/**
 * Motion for a list's rows: leaving rows kept for their exit, and FLIP for the rows that moved.
 * Rows are `container`'s children with `attr` (their id). `context` names what the rows are
 * ordered by (sort, list id): when it changes, the person changed the view and nothing animates.
 * When `folding` changes (groups or rows expanded or collapsed) hidden rows go at once while
 * the rest slide. `ready` is false until the list's first paint (the hook keeps its own).
 */
export function useRowMotion<T extends { id: string }>(
	items: T[],
	{ container, scroller, attr = "data-row-id", context = "", folding = "", ready: givenReady }: { container: RefObject<HTMLElement | null>; scroller?: RefObject<HTMLElement | null>; attr?: string; context?: string; folding?: string; ready?: { current: boolean } },
): Motion<T> {
	const ownReady = useRef(false);
	const ready = givenReady ?? ownReady;
	useEffect(() => {
		if (givenReady) return;
		const frame = requestAnimationFrame(() => (ownReady.current = true));
		return () => cancelAnimationFrame(frame);
	}, [givenReady]);
	const quietUntil = useRef(0);
	useEffect(() => {
		const mark = (e: Event) => changesView(e.target as Element | null) && (quietUntil.current = performance.now() + QUIET_MS);
		window.addEventListener("pointerdown", mark, true);
		window.addEventListener("keydown", mark, true);
		return () => {
			window.removeEventListener("pointerdown", mark, true);
			window.removeEventListener("keydown", mark, true);
		};
	}, []);
	const lastContext = useRef(context);
	const calm = () => ready.current && !reducedMotion() && performance.now() > quietUntil.current && lastContext.current === context;

	// Derived during render, so a leaving row never unmounts and comes back.
	const [track, setTrack] = useState(() => ({ items, folding, leaving: new Map<string, Leaving<T>>(), entering: new Set<string>() }));
	let { leaving, entering } = track;
	if (track.items !== items) {
		const animate = calm();
		leaving = animate && track.folding === folding ? leavingRows(track.items, items, track.leaving, performance.now()) : new Map();
		const known = new Set(track.items.map((it) => it.id));
		entering = animate ? new Set([...track.entering, ...items.filter((it) => !known.has(it.id)).map((it) => it.id)]) : new Set();
		setTrack({ items, folding, leaving, entering });
	}
	useEffect(() => {
		if (!track.entering.size) return;
		const ids = new Set(track.entering);
		const timer = setTimeout(() => setTrack((t) => ({ ...t, entering: new Set([...t.entering].filter((id) => !ids.has(id))) })), ENTER_MS);
		return () => clearTimeout(timer);
	}, [track.entering]);
	useEffect(() => {
		if (!track.leaving.size) return;
		const ids = [...track.leaving.keys()];
		const timer = setTimeout(() => setTrack((t) => ({ ...t, leaving: new Map([...t.leaving].filter(([id]) => !ids.includes(id))) })), EXIT_MS);
		return () => clearTimeout(timer);
	}, [track.leaving]);
	const rows = useMemo(() => withLeaving(items, leaving), [items, leaving]);

	const landing = useRef<{ id: string; y: number } | null>(null);
	const land = useMemo(() => (id: string, y: number) => void (landing.current = { id, y }), []);

	// FLIP: where each row was laid out last time; rows that moved start there and slide over.
	const tops = useRef(new Map<string, number>());
	useLayoutEffect(() => {
		const animate = calm();
		lastContext.current = context;
		const dropped = landing.current;
		landing.current = null;
		const els = [...(container.current?.querySelectorAll<HTMLElement>(`:scope > [${attr}]`) ?? [])];
		const view = scroller?.current;
		const lo = (view?.scrollTop ?? 0) - (view?.clientHeight ?? 0), hi = (view?.scrollTop ?? 0) + 2 * (view?.clientHeight ?? Infinity);
		const next = new Map<string, number>();
		const moved: [HTMLElement, number][] = [];
		for (const el of els) {
			const id = el.getAttribute(attr)!, top = el.offsetTop;
			next.set(id, top);
			const shift = currentShift(el);
			if (!animate) {
				if (shift) (el.style.transition = ""), (el.style.transform = "");
				continue;
			}
			if (dropped?.id === id) {
				// From under the pointer, where it was let go.
				const r = el.getBoundingClientRect();
				moved.push([el, dropped.y - r.height / 2 - (r.top - shift)]);
				continue;
			}
			const was = tops.current.get(id);
			if (was === undefined || (was === top && !shift)) continue;
			if ((was < lo || was > hi) && (top < lo || top > hi)) continue;
			moved.push([el, slideFrom(was, top, shift)]);
		}
		tops.current = next;
		if (!moved.length) return;
		for (const [el, dy] of moved) {
			el.style.transition = "none";
			el.style.transform = `translateY(${dy}px)`;
		}
		// Commit the start position before transitioning from it.
		void container.current?.offsetHeight;
		for (const [el] of moved) {
			el.style.transition = `transform ${MOVE_MS}ms ${EASE}`;
			el.style.transform = "";
		}
		const done = setTimeout(() => moved.forEach(([el]) => !el.style.transform && (el.style.transition = "")), MOVE_MS + 50);
		return () => clearTimeout(done);
	}, [rows, context]);

	return { rows, entering, land };
}
