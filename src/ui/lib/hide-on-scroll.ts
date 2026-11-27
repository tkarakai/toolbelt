// On a phone, the pane header and the bottom tab bar slide away while the content scrolls down
// and come back as soon as it scrolls up, or reaches the top (docs/remote-access.md, "Narrow
// screens"). The decision is pure (`nextChrome`, tested in test/hide-on-scroll.test.ts).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Scrolling down this far (px, in one go) hides the bars. */
export const HIDE_AFTER = 24;
/** Scrolling up this far brings them back: sooner than hiding, as people look for them. */
export const SHOW_AFTER = 12;
/** Within this distance of the top the bars always show. */
export const REVEAL_TOP = 8;
/** After the bars change, scroll events are ignored this long (ms): their own size change can
 *  move a scroll position that was at the bottom, which mustn't count as scrolling back. */
export const SETTLE_MS = 300;

export type Chrome = { hidden: boolean; /** distance scrolled in the current direction (+ down) */ travel: number };

/**
 * The bars' next state after content scrolled to `top` by `delta`, with `room` px it can
 * scroll in all, given the bars' combined `height`. Content with little to scroll keeps them:
 * hiding them would leave it with nothing to scroll.
 */
export function nextChrome(s: Chrome, top: number, delta: number, room: number, height: number): Chrome {
	if (top <= REVEAL_TOP) return { hidden: false, travel: 0 };
	if (!s.hidden && room < height * 2) return { hidden: false, travel: 0 };
	if (delta === 0) return s;
	const travel = Math.sign(delta) === Math.sign(s.travel) ? s.travel + delta : delta;
	if (!s.hidden && travel >= HIDE_AFTER) return { hidden: true, travel: 0 };
	if (s.hidden && travel <= -SHOW_AFTER) return { hidden: false, travel: 0 };
	return { hidden: s.hidden, travel };
}

/**
 * Whether content `fromEnd` px short of its end keeps that distance from its end while bars of
 * combined `height` come back. The bars take their room from the content, so without this the
 * content's last `height` px would end up below its shrunken view, where the tab bar reappears,
 * and scrolling down to them hides the bars again. Further up, the content keeps its top.
 */
export function keepsEnd(fromEnd: number, height: number): boolean {
	return fromEnd < Math.max(height, REVEAL_TOP);
}

/**
 * Watches vertical scrolling anywhere inside `root` (a table, a settings page) and says whether
 * the bars should be hidden. `reset` (a new screen or tab) brings them back. `show` brings them
 * back on demand (focus moved into them). Horizontal scrolling doesn't count.
 */
export function useHideOnScroll(root: RefObject<HTMLElement | null>, enabled: boolean, reset: unknown, barsHeight: () => number) {
	const [hidden, setHidden] = useState(false);
	const state = useRef<Chrome>({ hidden: false, travel: 0 });
	// The content scrolled last: the one to keep at its end when the bars come back.
	const scrolled = useRef<HTMLElement | null>(null);
	const wasHidden = useRef(false);
	const pinning = useRef(false);
	const height = useRef(barsHeight);
	height.current = barsHeight;
	const show = useCallback(() => {
		state.current = { hidden: false, travel: 0 };
		setHidden(false);
	}, []);
	useEffect(show, [reset, enabled, show]);
	useEffect(() => {
		const el = root.current;
		if (!el || !enabled) return;
		const last = new WeakMap<Element, number>();
		let quietUntil = 0;
		const onScroll = (e: Event) => {
			const t = e.target;
			if (!(t instanceof HTMLElement) || t.closest("[data-hide-on-scroll]")) return;
			scrolled.current = t;
			const top = t.scrollTop;
			const prev = last.get(t) ?? top;
			last.set(t, top);
			if (top === prev || pinning.current || performance.now() < quietUntil) return;
			const next = nextChrome(state.current, top, top - prev, t.scrollHeight - t.clientHeight, height.current());
			if (next.hidden !== state.current.hidden) {
				quietUntil = performance.now() + SETTLE_MS;
				setHidden(next.hidden);
			}
			state.current = next;
		};
		el.addEventListener("scroll", onScroll, { capture: true, passive: true });
		return () => el.removeEventListener("scroll", onScroll, { capture: true });
	}, [root, enabled, reset]);
	// The bars coming back near the content's end: keep its distance from the end while their
	// rows grow (each step of the 200 ms transition resizes it), until the person scrolls up.
	useLayoutEffect(() => {
		const was = wasHidden.current;
		wasHidden.current = hidden;
		const el = scrolled.current;
		if (hidden || !was || !el?.isConnected || !root.current?.contains(el)) return;
		const fromEnd = el.scrollHeight - el.clientHeight - el.scrollTop;
		if (!keepsEnd(fromEnd, height.current())) return;
		let pinned = el.scrollTop;
		const pin = () => {
			el.scrollTop = el.scrollHeight - el.clientHeight - fromEnd;
			pinned = el.scrollTop;
		};
		const onScroll = () => { if (el.scrollTop < pinned - 1) stop(); };
		const observer = new ResizeObserver(pin);
		pinning.current = true;
		const timer = setTimeout(stop, SETTLE_MS + 100);
		function stop() {
			pinning.current = false;
			observer.disconnect();
			el!.removeEventListener("scroll", onScroll);
			clearTimeout(timer);
		}
		observer.observe(el);
		el.addEventListener("scroll", onScroll, { passive: true });
		return stop;
	}, [hidden, root]);
	return { hidden, show };
}
