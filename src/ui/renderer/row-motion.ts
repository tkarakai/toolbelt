// Table rows that move when a plugin's refresh reorders them: rows that leave fade out in place
// (EXIT_MS), then the rows around them slide to their new places (MOVE_MS). Only refreshes the
// person didn't just cause animate: sorting, filtering, typing, collapsing and clicking change
// the table at once. Reduced motion and the table's first paint never animate.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

export const MOVE_MS = 200;
export const EXIT_MS = 150;
/** More rows than this leaving at once is a different list, not a refresh: no exit animation. */
const MAX_LEAVING = 30;
/** Changes arriving this soon after a click or key press are the person's doing. */
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
 * Rows to render for a table body, with leaving rows kept for their exit, and FLIP for the rows
 * that moved. `context` names what the rows are ordered by (sort, table id): when it changes, the
 * person changed the view and nothing animates. `ready` is false until the table's first paint.
 */
export function useRowMotion<T extends { id: string }>(items: T[], body: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, context: string, ready: { current: boolean }) {
	const quietUntil = useRef(0);
	useEffect(() => {
		const mark = () => (quietUntil.current = performance.now() + QUIET_MS);
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
	const [track, setTrack] = useState(() => ({ items, leaving: new Map<string, Leaving<T>>() }));
	let leaving = track.leaving;
	if (track.items !== items) {
		leaving = calm() ? leavingRows(track.items, items, track.leaving, performance.now()) : new Map();
		setTrack({ items, leaving });
	}
	useEffect(() => {
		if (!track.leaving.size) return;
		const ids = [...track.leaving.keys()];
		const timer = setTimeout(() => setTrack((t) => ({ ...t, leaving: new Map([...t.leaving].filter(([id]) => !ids.includes(id))) })), EXIT_MS);
		return () => clearTimeout(timer);
	}, [track.leaving]);
	const rows = useMemo(() => withLeaving(items, leaving), [items, leaving]);

	// FLIP: where each row was laid out last time; rows that moved start there and slide over.
	const tops = useRef(new Map<string, number>());
	useLayoutEffect(() => {
		const animate = calm();
		lastContext.current = context;
		const els = [...(body.current?.querySelectorAll<HTMLElement>(":scope > [data-row-id]") ?? [])];
		const view = scroller.current;
		const lo = (view?.scrollTop ?? 0) - (view?.clientHeight ?? 0), hi = (view?.scrollTop ?? 0) + 2 * (view?.clientHeight ?? Infinity);
		const next = new Map<string, number>();
		const moved: [HTMLElement, number][] = [];
		for (const el of els) {
			const id = el.dataset.rowId!, top = el.offsetTop;
			next.set(id, top);
			const was = tops.current.get(id);
			if (!animate || was === undefined || was === top) continue;
			if ((was < lo || was > hi) && (top < lo || top > hi)) continue;
			moved.push([el, was - top]);
		}
		tops.current = next;
		if (!moved.length) return;
		for (const [el, dy] of moved) {
			el.style.transition = "none";
			el.style.transform = `translateY(${dy}px)`;
		}
		const frame = requestAnimationFrame(() => {
			for (const [el] of moved) {
				el.style.transition = `transform ${MOVE_MS}ms cubic-bezier(0.215, 0.61, 0.355, 1)`;
				el.style.transform = "";
			}
		});
		const done = setTimeout(() => moved.forEach(([el]) => (el.style.transition = "")), MOVE_MS + 50);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(done);
			for (const [el] of moved) (el.style.transition = ""), (el.style.transform = "");
		};
	}, [rows, context]);

	return rows;
}
