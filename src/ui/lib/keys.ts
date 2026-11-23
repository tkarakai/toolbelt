// Pure keyboard rules shared by every surface (no DOM access, so they are unit-tested in
// test/keyboard.test.ts). `keyboard.tsx` applies them to the document.

/** What a focused element is, as far as its own keys are concerned. */
export type WidgetInfo = {
	tag: string;
	/** `type` of an <input>. */
	type?: string;
	role?: string | null;
	/** `aria-orientation` of the element or, for tabs and radios, of their group. */
	orientation?: string | null;
	editable?: boolean;
};

const NAVIGATION = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
const ACTIVATE = ["Enter", " "];
const NOT_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "color", "range", "image", "hidden"]);
/** Composite widgets that use arrows, Home/End, Enter/Space and typeahead themselves. */
const COMPOSITES = new Set(["menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "listbox", "option", "tree", "treeitem", "combobox", "grid", "treegrid", "gridcell"]);
const RANGES = new Set(["slider", "scrollbar", "spinbutton", "separator"]);

/**
 * The keys a focused element handles itself, which page-level shortcuts and collections must
 * leave alone: `"text"` for text entry (every key without ⌘/⌃ except Esc, Tab and F-keys),
 * else a list. Unknown elements claim nothing.
 */
export function widgetKeys(w: WidgetInfo): "text" | string[] {
	const tag = w.tag.toLowerCase();
	const role = w.role ?? undefined;
	if (w.editable || tag === "textarea" || tag === "select" || role === "textbox" || role === "searchbox") return "text";
	if (tag === "input") {
		if (w.type === "range") return [...NAVIGATION];
		if (w.type === "checkbox" || w.type === "radio") return w.type === "radio" ? [...NAVIGATION, " "] : [" "];
		if (!NOT_TEXT_INPUTS.has(w.type ?? "text")) return "text";
		return [...ACTIVATE];
	}
	if (role && COMPOSITES.has(role)) return [...NAVIGATION, ...ACTIVATE, "typeahead"];
	if (role && RANGES.has(role)) return role === "separator" ? [...NAVIGATION, "Enter"] : [...NAVIGATION];
	if (role === "tab" || role === "tablist" || role === "toolbar") {
		const vertical = w.orientation === "vertical";
		return [...(vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"]), "Home", "End", ...ACTIVATE];
	}
	if (role === "radio" || role === "radiogroup") return [...NAVIGATION, " "];
	if (tag === "button" || tag === "a" || tag === "summary" || role === "button" || role === "link" || role === "checkbox" || role === "switch") return [...ACTIVATE];
	return [];
}

/** Whether `keys` (from `widgetKeys`) includes this key press. */
export function claims(keys: "text" | string[], e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): boolean {
	if (keys === "text") return !e.metaKey && !e.ctrlKey && e.key !== "Escape" && e.key !== "Tab" && !/^F\d+$/.test(e.key);
	if (e.metaKey || e.ctrlKey) return false;
	// ⌥-arrows are collection/row shortcuts, not widget navigation.
	if (e.altKey && e.key.startsWith("Arrow")) return false;
	if (keys.includes(e.key)) return true;
	return keys.includes("typeahead") && e.key.length === 1 && !e.altKey;
}

export type Direction = "up" | "down" | "left" | "right";
export type Rect = { left: number; top: number; width: number; height: number };

/**
 * The item a 2-D arrow press moves to in a wrapping grid of rectangles (cards, swatches): the
 * nearest item whose center lies in that direction, preferring the same row or column. Returns
 * `from` when nothing lies that way.
 */
export function nearestInDirection(rects: Rect[], from: number, dir: Direction): number {
	const a = rects[from];
	if (!a) return from;
	const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
	let best = from, score = Infinity;
	rects.forEach((r, i) => {
		if (i === from) return;
		const x = r.left + r.width / 2, y = r.top + r.height / 2;
		const dx = x - ax, dy = y - ay;
		const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
		const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
		// Strictly in that direction (half a pixel of slack for rounding).
		if (along <= 0.5) return;
		// Off-axis distance weighs heavily, so the same row/column wins over a closer diagonal.
		const s = along + across * 4;
		if (s < score) (score = s), (best = i);
	});
	return best;
}

/** The index a key moves to in a one-dimensional group, or `null` when the key isn't a move. */
export function stepIndex(count: number, from: number, key: string, orientation: "vertical" | "horizontal" | "both", loop = false): number | null {
	if (count <= 0) return null;
	const back = (orientation !== "horizontal" && key === "ArrowUp") || (orientation !== "vertical" && key === "ArrowLeft");
	const forward = (orientation !== "horizontal" && key === "ArrowDown") || (orientation !== "vertical" && key === "ArrowRight");
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	if (!back && !forward) return null;
	if (from < 0) return back ? count - 1 : 0;
	const next = from + (back ? -1 : 1);
	if (loop) return (next + count) % count;
	return Math.max(0, Math.min(count - 1, next));
}

/**
 * A resize handle's new size for a key press: arrows move by `step` (×5 with ⇧) toward the
 * arrow, Home/End go to the limits. `grows` is the arrow that makes the size larger (a sidebar's
 * right edge grows with →, a drawer's left edge with ←). `null`: not a resize key.
 */
export function resizeKey(key: string, shift: boolean, value: number, { min, max, step = 16, grows }: { min: number; max: number; step?: number; grows: "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp" }): number | null {
	const opposite = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowDown: "ArrowUp", ArrowUp: "ArrowDown" }[grows];
	const amount = step * (shift ? 5 : 1);
	if (key === grows) return Math.min(max, value + amount);
	if (key === opposite) return Math.max(min, value - amount);
	if (key === "Home") return min;
	if (key === "End") return max;
	return null;
}

const GLYPHS: Record<string, string> = { "⌘": "Meta", "⌥": "Alt", "⌃": "Control", "⇧": "Shift" };
const NAMED: Record<string, string> = {
	"↵": "Enter", enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", "⌫": "Backspace", backspace: "Backspace", delete: "Delete", "⌦": "Delete",
	"↑": "ArrowUp", up: "ArrowUp", "↓": "ArrowDown", down: "ArrowDown", "←": "ArrowLeft", left: "ArrowLeft", "→": "ArrowRight", right: "ArrowRight",
	"⇥": "Tab", tab: "Tab", space: "Space", " ": "Space", home: "Home", end: "End",
};
const WORD_MODIFIERS: Record<string, string> = { cmd: "Meta", meta: "Meta", command: "Meta", alt: "Alt", option: "Alt", opt: "Alt", ctrl: "Control", control: "Control", shift: "Shift" };

/**
 * An `aria-keyshortcuts` value from a shortcut as people see it ("⌥⌘1", "⌘G", "esc", "↵") or as
 * plugins declare it ("alt+up", "shift+j", "p"). Unknown text passes through unchanged.
 */
export function ariaShortcut(keys: string): string {
	const raw = keys.trim();
	if (!raw) return "";
	let mods: string[] = [];
	let key: string;
	if (raw.length > 1 && raw.includes("+")) {
		const parts = raw.split("+");
		key = parts.pop()!;
		mods = parts.map((p) => WORD_MODIFIERS[p.toLowerCase()] ?? p);
	} else {
		let rest = raw;
		while (rest.length > 1 && GLYPHS[rest[0]!]) (mods.push(GLYPHS[rest[0]!]!), (rest = rest.slice(1)));
		key = rest;
	}
	const order = ["Control", "Alt", "Shift", "Meta"];
	mods = order.filter((m) => mods.includes(m));
	const named = NAMED[key] ?? NAMED[key.toLowerCase()];
	const name = named ?? (key.length === 1 && mods.length ? key.toUpperCase() : key);
	return [...mods, name].join("+");
}
