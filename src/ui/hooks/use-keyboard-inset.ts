// How much of the bottom of the window an on-screen keyboard covers, in CSS pixels (0 without
// one). iOS keeps fixed elements in the layout viewport and only shrinks the visual viewport when
// the keyboard opens, so a bottom sheet lifts itself by this much to keep its input in view.
import { useEffect, useState } from "react";

/** Below this, the difference is browser chrome (a collapsing toolbar), not a keyboard. */
const KEYBOARD_MIN = 80;

export function keyboardInset(layoutHeight: number, visual: { height: number; offsetTop: number }): number {
	const covered = Math.round(layoutHeight - visual.height - visual.offsetTop);
	return covered >= KEYBOARD_MIN ? covered : 0;
}

export function useKeyboardInset(active = true): number {
	const [inset, setInset] = useState(0);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!active || !vv) return setInset(0);
		const update = () => setInset(keyboardInset(window.innerHeight, vv));
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	}, [active]);
	return inset;
}
