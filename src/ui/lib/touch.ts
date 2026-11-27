// Touch gestures for phones and tablets (docs/remote-access.md, "Touch"). The decisions are pure
// functions (tested in test/touch.test.ts); the hooks below wire them to pointer and touch events.
//
// - Long press: holding a finger still on a row opens its actions menu, or lifts it for dragging
//   where the list can be reordered. A press that moves first is a scroll and never a drag.
// - Edge swipe: a swipe from the screen's left edge brings in the tools sheet.
// - Sheet drag: sheets follow the finger from their grabber, header or content scrolled to its top,
//   and close (or change height) when flung or pulled far enough.
import { useCallback, useEffect, useRef } from "react";

/** How long a finger rests before a press becomes a long press (ms). iOS uses about 500. */
export const HOLD_MS = 450;
/** How far a finger may drift during a long press before it counts as scrolling (px). */
export const HOLD_SLOP = 8;
/** The strip along the left edge where a swipe starts the tools sheet (px). */
export const EDGE_ZONE = 24;
/** How far an edge swipe travels before the sheet opens (px). */
export const EDGE_OPEN = 48;

/** Whether a press is still a candidate for a long press after drifting by (dx, dy). */
export const holdStillEnough = (dx: number, dy: number, slop = HOLD_SLOP) => Math.hypot(dx, dy) <= slop;

/**
 * An edge swipe in progress: "open" once it has gone far enough mostly sideways, "cancel" once it
 * is clearly vertical or backwards (a scroll), else "track" (undecided).
 */
export function edgeSwipe(startX: number, dx: number, dy: number, zone = EDGE_ZONE, open = EDGE_OPEN): "open" | "cancel" | "track" {
	if (startX > zone) return "cancel";
	if (Math.abs(dy) > 24 && Math.abs(dy) > dx) return "cancel";
	if (dx < -8) return "cancel";
	if (dx >= open && dx > Math.abs(dy) * 1.5) return "open";
	return "track";
}

/** Movement before a press counts as a sheet drag or a scroll (px). */
export const DRAG_SLOP = 6;
/** A fling this fast (px/ms) moves a sheet one step (smaller, larger or closed)... */
export const FLING = 0.5;
/** ...when it also travels at least this far (px): a flick of a few pixels isn't deliberate. */
export const FLING_MIN = 32;
/** A pull past this share of the sheet's (smallest) height closes it. */
export const PULL_SHARE = 0.3;
/** Content that scrolled this recently (ms; momentum included) keeps the finger: a swipe that
 *  scrolls a list back to its top, or the next one right after, never closes the sheet. */
export const SCROLL_LOCK_MS = 400;
/** The window release velocity is measured over (ms). */
export const VELOCITY_WINDOW = 100;

/**
 * What a touch on a sheet becomes, once it has moved `along` px towards the sheet's closed side
 * (negative: the other way) and `across` px sideways:
 * - "drag" moves the sheet: towards closing only when the content under the finger is at its top
 *   (`atTop`) and hasn't scrolled for `SCROLL_LOCK_MS` (`sinceScroll`), or the touch started on
 *   the grabber or header (`handle`); the other way only from the handle of a sheet that can
 *   grow (`canExpand`).
 * - "scroll" leaves the touch to the content for the rest of the gesture.
 * - "wait" until it has moved far enough to tell.
 */
export function sheetIntent({ along, across, atTop, sinceScroll, handle, canExpand }: { along: number; across: number; atTop: boolean; sinceScroll: number; handle: boolean; canExpand: boolean }): "drag" | "scroll" | "wait" {
	if (Math.abs(across) > 10 && Math.abs(across) > Math.abs(along)) return "scroll";
	if (Math.abs(along) < DRAG_SLOP) return "wait";
	if (along > 0) return handle || (atTop && sinceScroll >= SCROLL_LOCK_MS) ? "drag" : "scroll";
	return handle && canExpand ? "drag" : "scroll";
}

/**
 * Where a released sheet settles: the index of one of its `heights` (ascending, px), or -1 to
 * close. `drag` is how far it was pulled towards closing (px, negative: the other way) from height
 * `from`, at `velocity` px/ms (positive towards closing). A deliberate fling moves one step; else
 * it goes to the nearest height, and closes only when pulled `PULL_SHARE` below the smallest.
 */
export function settle(drag: number, velocity: number, heights: number[], from: number): number {
	const last = heights.length - 1;
	if (velocity >= FLING && drag >= FLING_MIN) return from - 1;
	if (velocity <= -FLING && drag <= -FLING_MIN) return Math.min(from + 1, last);
	const h = heights[from] - drag;
	if (h < heights[0]) return heights[0] - h >= heights[0] * PULL_SHARE ? -1 : 0;
	let best = 0;
	for (let i = 1; i <= last; i++) if (Math.abs(heights[i] - h) < Math.abs(heights[best] - h)) best = i;
	return best;
}

/** Release velocity (px/ms) from `samples` of distance over time, over the last `VELOCITY_WINDOW`
 *  ms before `now`: a finger that stopped before lifting has none. */
export function releaseVelocity(samples: { d: number; t: number }[], now: number): number {
	const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW);
	if (recent.length < 2) return 0;
	const a = recent[0], b = recent[recent.length - 1];
	return (b.d - a.d) / Math.max(1, b.t - a.t);
}

/** How far a sheet follows a pull: freely towards closing, with resistance the other way. */
export const pullOffset = (distance: number) => (distance >= 0 ? distance : -Math.sqrt(-distance) * 2);

/**
 * How a sheet shows `drag` px of pull from height `from` of its `heights`: its height (only for a
 * sheet with several) and how far it's moved towards closing (negative: past its largest height,
 * with resistance).
 */
export function dragFrame(drag: number, heights: number[], from: number): { height: number; offset: number } {
	const min = heights[0], max = heights[heights.length - 1];
	const h = heights[from] - drag;
	if (h > max) return { height: max, offset: pullOffset(max - h) };
	if (h < min) return { height: min, offset: min - h };
	return { height: h, offset: 0 };
}

/** A light tap of feedback where the device supports it (Android; iOS ignores vibrate). */
export function haptic() {
	try {
		navigator.vibrate?.(8);
	} catch {
		/* not supported */
	}
}

type Hold = {
	/** The press became a long press. */
	onHold: () => void;
	/** The finger moved too soon (a scroll) or lifted early: an ordinary tap or scroll. */
	onCancel?: () => void;
	delay?: number;
};

/**
 * Starts watching a touch press for a long press. Mouse and pen presses are ignored (returns
 * false), so callers keep their usual behavior for them. While the long press lasts (until the
 * finger lifts), page scrolling is held off, so a drag that follows can move freely.
 */
export function watchHold(e: { pointerType: string; pointerId: number; clientX: number; clientY: number }, { onHold, onCancel, delay = HOLD_MS }: Hold): boolean {
	if (e.pointerType !== "touch") return false;
	const x0 = e.clientX, y0 = e.clientY, id = e.pointerId;
	let held = false;
	const noScroll = (ev: TouchEvent) => ev.cancelable && ev.preventDefault();
	const timer = setTimeout(() => {
		held = true;
		window.addEventListener("touchmove", noScroll, { passive: false });
		haptic();
		onHold();
	}, delay);
	const move = (ev: PointerEvent) => {
		if (ev.pointerId !== id || held) return;
		if (!holdStillEnough(ev.clientX - x0, ev.clientY - y0)) end(true);
	};
	const end = (cancelled: boolean) => {
		clearTimeout(timer);
		window.removeEventListener("pointermove", move);
		window.removeEventListener("pointerup", up);
		window.removeEventListener("pointercancel", cancel);
		// Keep scrolling held off until this finger's touch ends: a drag may still be moving.
		if (held) window.addEventListener("touchend", () => window.removeEventListener("touchmove", noScroll), { once: true });
		if (cancelled && !held) onCancel?.();
	};
	const up = (ev: PointerEvent) => ev.pointerId === id && end(!held);
	const cancel = (ev: PointerEvent) => ev.pointerId === id && end(true);
	window.addEventListener("pointermove", move);
	window.addEventListener("pointerup", up);
	window.addEventListener("pointercancel", cancel);
	return true;
}

/** A swipe in from the left edge of the screen calls `onOpen` (when `enabled`). */
export function useEdgeSwipe(onOpen: () => void, enabled: boolean) {
	const open = useRef(onOpen);
	open.current = onOpen;
	useEffect(() => {
		if (!enabled) return;
		let start: { x: number; y: number } | null = null;
		const down = (e: TouchEvent) => {
			const t = e.touches[0];
			start = e.touches.length === 1 && t && t.clientX <= EDGE_ZONE ? { x: t.clientX, y: t.clientY } : null;
		};
		const move = (e: TouchEvent) => {
			const t = e.touches[0];
			if (!start || !t) return;
			const verdict = edgeSwipe(start.x, t.clientX - start.x, t.clientY - start.y);
			if (verdict === "track") return;
			start = null;
			if (verdict === "open") open.current();
		};
		const up = () => (start = null);
		window.addEventListener("touchstart", down, { passive: true });
		window.addEventListener("touchmove", move, { passive: true });
		window.addEventListener("touchend", up, { passive: true });
		window.addEventListener("touchcancel", up, { passive: true });
		return () => {
			window.removeEventListener("touchstart", down);
			window.removeEventListener("touchmove", move);
			window.removeEventListener("touchend", up);
			window.removeEventListener("touchcancel", up);
		};
	}, [enabled]);
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Where a touch starting on `target` would scroll the content along the sheet's axis instead:
 *  the scrollable boxes it is in, inside `root`. A terminal scrolls a sibling of what's touched. */
function scrollersAt(target: Element | null, root: HTMLElement, side: "left" | "bottom"): HTMLElement[] {
	const found: HTMLElement[] = [];
	const term = target?.closest?.(".xterm")?.querySelector<HTMLElement>(".xterm-viewport");
	if (term && root.contains(term)) found.push(term);
	for (let n = target as HTMLElement | null; n && n !== root; n = n.parentElement) {
		const style = getComputedStyle(n);
		if (side === "bottom" && /(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight + 1) found.push(n);
		if (side === "left" && /(auto|scroll)/.test(style.overflowX) && n.scrollWidth > n.clientWidth + 1) found.push(n);
	}
	return found;
}

export type SheetDrag = {
	/** The edge the sheet is attached to. */
	side: "left" | "bottom";
	onDismiss: () => void;
	/** A bottom sheet with several heights: which one it's at, how to change it, and their sizes
	 *  in px (ascending), read when a drag starts. */
	detent?: number;
	onDetent?: (index: number) => void;
	heights?: () => number[];
};

/**
 * Lets a finger move a sheet. Towards its closed side, the sheet follows and closes when flung or
 * pulled far enough, otherwise springs back; a sheet with several `heights` grows and shrinks
 * between them first, settling on the nearest (a fling moves one step). The rules for which touches
 * move the sheet and which scroll its content are `sheetIntent`'s: the grabber and header, or
 * content scrolled to its top and at rest. Mark the grabber and header `data-sheet-handle`.
 */
export function useSheetDrag({ side, onDismiss, detent = 0, onDetent, heights }: SheetDrag) {
	const props = useRef({ onDismiss, detent, onDetent, heights });
	props.current = { onDismiss, detent, onDetent, heights };
	const detach = useRef<(() => void) | null>(null);
	// A callback ref: the listeners live as long as the element (sheets mount in portals, late).
	return useCallback((el: HTMLElement | null) => {
		detach.current?.();
		detach.current = null;
		if (!el) return;
		/** When each scrollable box in the sheet last scrolled (momentum included). */
		const scrolled = new WeakMap<EventTarget, number>();
		const onScroll = (e: Event) => e.target && scrolled.set(e.target, performance.now());
		type Gesture = { x: number; y: number; target: Element | null; handle: boolean; state: "wait" | "drag"; sizes: number[]; from: number; samples: { d: number; t: number }[]; d: number };
		let g: Gesture | null = null;
		const sizesNow = () => {
			const own = props.current.heights?.();
			if (side === "bottom" && own && own.length > 1) return own;
			return [side === "left" ? el.offsetWidth : el.offsetHeight];
		};
		const ms = (n: number) => (reducedMotion() ? 0 : n);
		const show = (at: Gesture, drag: number, animate: boolean) => {
			const { height, offset } = dragFrame(drag, at.sizes, at.from);
			el.style.transition = animate ? `transform ${ms(200)}ms ease-out, height ${ms(200)}ms ease-out` : "none";
			if (at.sizes.length > 1) el.style.height = `${height}px`;
			el.style.transform = offset ? (side === "left" ? `translateX(${-offset}px)` : `translateY(${offset}px)`) : "";
		};
		const down = (e: TouchEvent) => {
			const t = e.touches[0];
			g = null;
			if (e.touches.length !== 1 || !t) return;
			const target = e.target as Element;
			if (target.closest?.("input, textarea, select, [contenteditable=true], .cm-editor, [data-sheet-no-drag]")) return;
			g = { x: t.clientX, y: t.clientY, target, handle: !!target.closest?.("[data-sheet-handle]"), state: "wait", sizes: [], from: 0, samples: [], d: 0 };
		};
		const move = (e: TouchEvent) => {
			const t = e.touches[0];
			if (!g || !t) return;
			const along = side === "left" ? g.x - t.clientX : t.clientY - g.y;
			const across = side === "left" ? t.clientY - g.y : t.clientX - g.x;
			if (g.state === "wait") {
				const scrollers = scrollersAt(g.target, el, side);
				const atTop = side === "left" ? scrollers.length === 0 : scrollers.every((n) => n.scrollTop <= 0);
				const last = Math.max(0, ...scrollers.map((n) => scrolled.get(n) ?? 0));
				const sizes = sizesNow();
				const from = Math.min(props.current.detent, sizes.length - 1);
				const intent = sheetIntent({ along, across, atTop, sinceScroll: performance.now() - last, handle: g.handle, canExpand: from < sizes.length - 1 && sizes[sizes.length - 1] > sizes[from] + 1 });
				if (intent === "wait") return;
				if (intent === "scroll") return void (g = null);
				// The drag starts here, so the sheet doesn't jump by the slop.
				g = { ...g, state: "drag", sizes, from, x: t.clientX, y: t.clientY };
			}
			if (e.cancelable) e.preventDefault();
			const d = side === "left" ? g.x - t.clientX : t.clientY - g.y;
			g.d = d;
			g.samples.push({ d, t: performance.now() });
			if (g.samples.length > 20) g.samples.shift();
			show(g, d, false);
		};
		const up = () => {
			const done = g;
			g = null;
			if (!done || done.state !== "drag") return;
			// A drag that ends on a button doesn't also press it.
			const swallow = (ev: Event) => (ev.stopPropagation(), ev.preventDefault());
			el.addEventListener("click", swallow, { capture: true, once: true });
			setTimeout(() => el.removeEventListener("click", swallow, { capture: true }), 400);
			const to = settle(done.d, releaseVelocity(done.samples, performance.now()), done.sizes, done.from);
			if (to < 0) {
				el.style.transition = `transform ${ms(200)}ms ease-out`;
				el.style.transform = side === "left" ? `translateX(${-el.offsetWidth}px)` : `translateY(${el.offsetHeight}px)`;
				setTimeout(() => {
					// Already off screen: no exit animation (it would start from the open position).
					// Closing unmounts the sheet, so the next one opens clean.
					el.style.animation = "none";
					props.current.onDismiss();
				}, ms(200));
			} else {
				show(done, done.sizes[done.from] - done.sizes[to], true);
				if (done.sizes.length > 1)
					setTimeout(() => {
						props.current.onDetent?.(to);
						// The sheet's own height (now the new one) takes over again.
						requestAnimationFrame(() => requestAnimationFrame(() => {
							el.style.transition = "";
							el.style.height = "";
						}));
					}, ms(200));
			}
		};
		el.addEventListener("scroll", onScroll, { capture: true, passive: true });
		el.addEventListener("touchstart", down, { passive: true });
		el.addEventListener("touchmove", move, { passive: false });
		el.addEventListener("touchend", up, { passive: true });
		el.addEventListener("touchcancel", up, { passive: true });
		detach.current = () => {
			el.removeEventListener("scroll", onScroll, { capture: true });
			el.removeEventListener("touchstart", down);
			el.removeEventListener("touchmove", move);
			el.removeEventListener("touchend", up);
			el.removeEventListener("touchcancel", up);
		};
	}, [side]);
}
