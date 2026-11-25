// On a phone, the pane header and the bottom tab bar slide away while the content scrolls down
// and come back as soon as it scrolls up, or reaches the top (docs/remote-access.md, "Narrow
// screens"). The decision is pure (`nextChrome`, tested in test/hide-on-scroll.test.ts).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

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
 * Watches vertical scrolling anywhere inside `root` (a table, a settings page) and says whether
 * the bars should be hidden. `reset` (a new screen or tab) brings them back. `show` brings them
 * back on demand (focus moved into them). Horizontal scrolling doesn't count.
 */
export function useHideOnScroll(root: RefObject<HTMLElement | null>, enabled: boolean, reset: unknown, barsHeight: () => number) {
	const [hidden, setHidden] = useState(false);
	const state = useRef<Chrome>({ hidden: false, travel: 0 });
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
			const top = t.scrollTop;
			const prev = last.get(t) ?? top;
			last.set(t, top);
			if (top === prev || performance.now() < quietUntil) return;
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
	return { hidden, show };
}
