// Picking colors for things people add: shared by the renderer (new items of an `options`
// field) and plugins (the SDK exports it), so both follow one rule.
import { HUES, type Hue } from "./protocol";

/** Hues picked for new things: the theme's colors without the two greys. */
const PICKABLE: readonly Hue[] = HUES.filter((h) => h !== "slate" && h !== "stone");

/**
 * A color for one more item in a list whose items use `used`: one the list uses least, chosen
 * at random among those (`random` returns [0, 1), like `Math.random`), and, when it can be, not
 * a neighbour on the color wheel of the last item's color, so red doesn't follow rose. Never a
 * grey.
 */
export function leastUsedHue(used: readonly (Hue | undefined)[], random: () => number = Math.random): Hue {
	const counts = new Map<Hue, number>(PICKABLE.map((h) => [h, 0]));
	for (const h of used) if (h && counts.has(h)) counts.set(h, counts.get(h)! + 1);
	const least = Math.min(...counts.values());
	const ties = PICKABLE.filter((h) => counts.get(h) === least);
	const last = [...used].reverse().find((h): h is Hue => !!h && counts.has(h));
	const at = last ? PICKABLE.indexOf(last) : -1;
	const far =
		at < 0
			? ties
			: ties.filter((h) => {
					const d = Math.abs(PICKABLE.indexOf(h) - at);
					return Math.min(d, PICKABLE.length - d) > 1;
				});
	const pool = far.length ? far : ties;
	return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
}
