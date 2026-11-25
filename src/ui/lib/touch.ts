// Touch gestures for phones and tablets (docs/remote-access.md, "Touch"). The decisions are pure
// functions (tested in test/touch.test.ts); the hooks below wire them to pointer and touch events.
//
// - Long press: holding a finger still on a row opens its actions menu, or lifts it for dragging
//   where the list can be reordered. A press that moves first is a scroll and never a drag.
// - Edge swipe: a swipe from the screen's left edge brings in the tools sheet.
// - Swipe to dismiss: sheets follow the finger and close when flung or pulled far enough.
import { useCallback, useEffect, useRef } from "react";

/** How long a finger rests before a press becomes a long press (ms). iOS uses about 500. */
export const HOLD_MS = 450;
/** How far a finger may drift during a long press before it counts as scrolling (px). */
export const HOLD_SLOP = 8;
/** The strip along the left edge where a swipe starts the tools sheet (px). */
export const EDGE_ZONE = 24;
/** How far an edge swipe travels before the sheet opens (px). */
export const EDGE_OPEN = 48;
/** A fling this fast (px/ms) dismisses a sheet however short the pull. */
export const FLING = 0.5;
/** A pull past this share of the sheet's size dismisses it. */
export const PULL_SHARE = 0.3;

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

/** Whether a sheet pulled `distance` px towards its closed side, at `velocity` px/ms, closes. */
export const dismisses = (distance: number, velocity: number, size: number) => distance > 0 && (velocity >= FLING || distance >= size * PULL_SHARE);

/** How far a sheet follows a pull: freely towards closing, with resistance the other way. */
export const pullOffset = (distance: number) => (distance >= 0 ? distance : -Math.sqrt(-distance) * 2);

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

/**
 * Lets a finger pull a sheet towards its closed side: it follows the finger and closes when
 * flung or pulled past `PULL_SHARE` of its size; otherwise it springs back. `side` is the edge
 * the sheet is attached to. A pull only starts where the content can't scroll that way itself
 * (a list scrolled to its top still lets a bottom sheet be pulled down).
 */
export function useSwipeDismiss(side: "left" | "bottom", onDismiss: () => void) {
	const dismiss = useRef(onDismiss);
	dismiss.current = onDismiss;
	const detach = useRef<(() => void) | null>(null);
	// A callback ref: the listeners live as long as the element (sheets mount in portals, late).
	return useCallback((el: HTMLElement | null) => {
		detach.current?.();
		detach.current = null;
		if (!el) return;
		let start: { x: number; y: number; t: number } | null = null;
		let pulling = false;
		let last = { d: 0, t: 0, v: 0 };
		const size = () => (side === "left" ? el.offsetWidth : el.offsetHeight);
		const distance = (t: Touch) => (side === "left" ? start!.x - t.clientX : t.clientY - start!.y);
		const across = (t: Touch) => (side === "left" ? t.clientY - start!.y : t.clientX - start!.x);
		/** Whether something under the finger would scroll in the pull's direction instead. */
		const scrollsFirst = (target: EventTarget | null) => {
			for (let n = target as HTMLElement | null; n && n !== el; n = n.parentElement) {
				const style = getComputedStyle(n);
				if (side === "bottom" && /(auto|scroll)/.test(style.overflowY) && n.scrollTop > 0) return true;
				if (side === "left" && /(auto|scroll)/.test(style.overflowX) && n.scrollWidth > n.clientWidth) return true;
			}
			return false;
		};
		const set = (offset: number, animate: boolean) => {
			el.style.transition = animate ? "transform 200ms ease-out" : "none";
			el.style.transform = offset ? (side === "left" ? `translateX(${-offset}px)` : `translateY(${offset}px)`) : "";
		};
		const down = (e: TouchEvent) => {
			const t = e.touches[0];
			start = e.touches.length === 1 && t && !scrollsFirst(e.target) && !(e.target as HTMLElement).closest?.("input, textarea, [contenteditable=true], .cm-editor") ? { x: t.clientX, y: t.clientY, t: e.timeStamp } : null;
			pulling = false;
			last = { d: 0, t: e.timeStamp, v: 0 };
		};
		const move = (e: TouchEvent) => {
			const t = e.touches[0];
			if (!start || !t) return;
			const d = distance(t);
			if (!pulling) {
				if (Math.abs(across(t)) > 10 && Math.abs(across(t)) > Math.abs(d)) return void (start = null);
				if (d < 6) return;
				pulling = true;
			}
			if (e.cancelable) e.preventDefault();
			const dt = Math.max(1, e.timeStamp - last.t);
			last = { d, t: e.timeStamp, v: (d - last.d) / dt };
			set(pullOffset(d), false);
		};
		const up = () => {
			if (!start) return;
			const was = pulling;
			start = null;
			pulling = false;
			if (!was) return;
			if (dismisses(last.d, last.v, size())) {
				set(size(), true);
				setTimeout(() => {
					// Already off screen: no exit animation (it would start from the open position).
					// Closing unmounts the sheet, so the next one opens clean.
					el.style.animation = "none";
					dismiss.current();
				}, 200);
			} else set(0, true);
		};
		el.addEventListener("touchstart", down, { passive: true });
		el.addEventListener("touchmove", move, { passive: false });
		el.addEventListener("touchend", up, { passive: true });
		el.addEventListener("touchcancel", up, { passive: true });
		detach.current = () => {
			el.removeEventListener("touchstart", down);
			el.removeEventListener("touchmove", move);
			el.removeEventListener("touchend", up);
			el.removeEventListener("touchcancel", up);
		};
	}, [side]);
}
