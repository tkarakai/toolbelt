// The renderer's pure parts — layout decisions and text helpers — kept free of React and the
// web view, so the tests can import them.
import type { Action, Column, DetailItem, Row, Section } from "../../shared/protocol";
import { flatSections, groupKey, sectionDepth, sectionGroup, subSectionParents } from "../../shared/sections";

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

/** Actions followed by their split-button alternatives (`menu`), in menu order. */
export const withAlternatives = (actions: Action[]): Action[] => actions.flatMap((a) => [a, ...(a.menu ?? [])]);

/** The enabled action or alternative whose one-key shortcut is `key` (case-insensitive). */
export const actionForKey = (actions: Action[], key: string): Action | undefined =>
	withAlternatives(actions).find((a) => !!a.key && a.key.toLowerCase() === key.toLowerCase() && !a.disabled);

type KeyLike = { key: string; code?: string; altKey?: boolean; shiftKey?: boolean };
const ARROWS: Record<string, string> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/**
 * The shortcut names a key press can mean, most specific first: `alt+shift+up`, then the plain
 * key ("j" also for J, as before modifier shortcuts). ⌥ changes the typed character on macOS
 * (⌥S types ß), so letters and digits with modifiers come from the physical key.
 */
export function keyNames(e: KeyLike): string[] {
	const arrow = ARROWS[e.key];
	const physical = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.code && /^Digit\d$/.test(e.code) ? e.code.slice(5) : undefined;
	const base = arrow ?? physical ?? e.key.toLowerCase();
	const mods = (e.altKey ? "alt+" : "") + (e.shiftKey ? "shift+" : "");
	const out: string[] = [];
	if (mods) out.push(mods + base);
	if (!e.altKey && !arrow && e.key.length === 1) out.push(e.key.toLowerCase());
	return out;
}

/** The enabled action or alternative whose shortcut this key press is. */
export function actionForEvent(actions: Action[], e: KeyLike): Action | undefined {
	const all = withAlternatives(actions);
	for (const name of keyNames(e)) {
		const a = all.find((x) => !!x.key && x.key.toLowerCase() === name && !x.disabled);
		if (a) return a;
	}
	return undefined;
}

/**
 * The action a key press inside an open action menu runs: the same shortcut as on the table,
 * but never with ⌘/⌃ or on auto-repeat. No match leaves the key to the menu (arrows, typeahead).
 */
export function menuActionForEvent(actions: Action[], e: KeyLike & { metaKey?: boolean; ctrlKey?: boolean; repeat?: boolean }): Action | undefined {
	if (e.metaKey || e.ctrlKey || e.repeat) return undefined;
	return actionForEvent(actions, e);
}

const KEY_SYMBOLS: Record<string, string> = { alt: "⌥", shift: "⇧", cmd: "⌘", up: "↑", down: "↓", left: "←", right: "→" };
/** macOS's modifier order: ⌥⇧⌘. */
const MODIFIER_ORDER = ["alt", "shift", "cmd"];
/** How a shortcut is shown: "alt+up" → "⌥↑", "cmd+shift+z" → "⇧⌘Z", "j" → "J". */
export function formatKey(key: string): string {
	if (key.length === 1) return key.toUpperCase();
	const parts = key.split("+");
	const mods = MODIFIER_ORDER.filter((m) => parts.includes(m));
	return [...mods, ...parts.filter((p) => !MODIFIER_ORDER.includes(p))].map((part) => KEY_SYMBOLS[part] ?? part.toUpperCase()).join("");
}

/**
 * Whether a key press is a toast button's shortcut (`cmd+z`, `cmd+shift+z`): exactly those
 * modifiers, the letter from the physical key, and not auto-repeat.
 */
export function isToastKey(key: string, e: KeyLike & { metaKey?: boolean; ctrlKey?: boolean; repeat?: boolean }): boolean {
	const m = /^cmd\+(shift\+)?([a-z])$/.exec(key);
	if (!m || !e.metaKey || e.ctrlKey || e.altKey || e.repeat || !!e.shiftKey !== !!m[1]) return false;
	const letter = e.code && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
	return letter === m[2];
}

// ── tree layout: a child's chevron starts where its parent's content does ──

/**
 * A chevron (20px) and the gap after it: where a group header's icon, or its title when it has
 * none, starts. Its children's chevrons (or unread slots) start here too, so every level indents
 * by the same step whatever icon the parent draws.
 */
export const INDENT = 28;
/** A row's chevron or unread slot (20px) and the margin after it: the row's text starts here. */
export const ROW_SLOT = 24;
/** How much further in an expanded row's children start than the row: under its text. */
export const ROW_STEP = ROW_SLOT;
/** The checkbox column of a table with bulk actions. */
export const CHECK_WIDTH = 40;

/**
 * Where a top-level row's chevron or unread slot starts, relative to the first column's
 * padding, given where its group header's chevron starts (from the table's padding). The
 * header spans the checkbox column and the row doesn't, so with `bulk` the row moves back by
 * it (into the cell's padding: at most 12px). Without groups, rows start at the edge.
 */
export function rowOffset(groupChevron: number | undefined, bulk: boolean): number {
	if (groupChevron === undefined) return 0;
	return groupChevron + INDENT - (bulk ? CHECK_WIDTH : 0);
}

// ── table columns: width, order, what fits ──────────────────────────────

/** The narrowest a growing column gets before other columns hide (when it sets no `minWidth`). */
export const GROW_MIN = 240;
/** The narrowest a fixed column can be dragged or shrunk to (when it sets no `minWidth`). */
export const COLUMN_MIN = 40;
/** A column without a declared width, before its content has been measured. */
export const COLUMN_FALLBACK = 96;

const weight = (v: boolean | number | undefined) => (v === true ? 1 : typeof v === "number" && v > 0 ? v : 0);
export const growOf = (c: Column) => weight(c.grow);
/** Growing columns give up space by default; fixed ones hide instead (unless they set `shrink`). */
export const shrinkOf = (c: Column) => (c.shrink === undefined ? growOf(c) : Math.max(0, c.shrink));
export const minOf = (c: Column) => Math.max(0, c.minWidth ?? (growOf(c) ? GROW_MIN : COLUMN_MIN));
export const maxOf = (c: Column) => Math.max(minOf(c), c.maxWidth ?? Infinity);
const clamp = (c: Column, w: number) => Math.min(maxOf(c), Math.max(minOf(c), w));

/**
 * Can the person drag this column elsewhere? The first declared column carries the tree
 * (chevrons, indentation, group labels), so it stays put unless the plugin says otherwise.
 */
export const isReorderable = (c: Column, declaredIndex: number) => c.reorderable ?? declaredIndex !== 0;
/** Fixed columns are resizable by default; growing ones take what's left. */
export const isResizable = (c: Column) => c.resizable ?? !growOf(c);

/**
 * The columns in the person's order (`saved`: column keys). Columns that can't move keep their
 * declared slot. Keys no longer declared are ignored; columns the person hasn't seen yet (a
 * plugin update) go right after the column they follow in the plugin's list.
 */
export function orderColumns(columns: Column[], saved: readonly string[] | undefined): Column[] {
	if (!saved?.length) return columns;
	const movable = columns.filter((c, i) => isReorderable(c, i));
	const byKey = new Map(movable.map((c) => [c.key, c]));
	const order: Column[] = [];
	for (const k of saved) {
		const c = byKey.get(k);
		if (c && !order.includes(c)) order.push(c);
	}
	movable.forEach((c, i) => {
		if (order.includes(c)) return;
		const before = movable.slice(0, i).reverse().find((p) => order.includes(p));
		order.splice(before ? order.indexOf(before) + 1 : 0, 0, c);
	});
	let next = 0;
	return columns.map((c, i) => (isReorderable(c, i) ? order[next++] : c));
}

/**
 * The saved order after dropping `key` before or after `target` — both movable. Returns every
 * movable key (hidden ones too), so columns come back where the person put them.
 */
export function moveColumn(ordered: Column[], declared: Column[], key: string, target: string, after: boolean): string[] {
	const movable = new Set(declared.filter((c, i) => isReorderable(c, i)).map((c) => c.key));
	const keys = ordered.map((c) => c.key).filter((k) => movable.has(k));
	if (key === target || !movable.has(key) || !movable.has(target)) return keys;
	const rest = keys.filter((k) => k !== key);
	rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, key);
	return rest;
}

export type ColumnLayout = {
	/** Width of each visible column, px. */
	widths: Record<string, number>;
	hidden: Set<string>;
	/** Sum of the visible columns and the fixed part; wider than `available` when it scrolls. */
	total: number;
};

/**
 * Where every column goes, given the width available — the same rules for every plugin:
 *
 * 1. Each column starts at the person's width (`saved`), else its declared `width`, else its
 *    measured content (`content`), kept within `minWidth`…`maxWidth`. Growing columns start at
 *    their `width` or `minWidth`.
 * 2. Spare space goes to growing columns by `grow` weight, up to their `maxWidth`.
 * 3. A shortfall comes out of columns with `shrink` (by weight), down to their `minWidth`.
 * 4. Still short: with `overflow: "hide"`, columns drop out — highest `priority` first;
 *    without one, the rightmost in the displayed order (`optional` ones before all others).
 *    The first column and growing columns that can't shrink further never drop. With
 *    `overflow: "scroll"`, nothing drops and the table scrolls sideways.
 *
 * `columns` is in displayed order; `fixed` is the space taken by checkboxes and row actions.
 */
export function layoutColumns(
	columns: Column[],
	available: number,
	opts: { saved?: Record<string, number>; content?: (c: Column) => number | undefined; fixed?: number; overflow?: "hide" | "scroll" } = {},
): ColumnLayout {
	const { saved = {}, content = () => undefined, fixed = 0, overflow = "hide" } = opts;
	const basis = (c: Column) => {
		if (growOf(c)) return clamp(c, typeof c.width === "number" ? c.width : minOf(c));
		const own = Object.hasOwn(saved, c.key) ? saved[c.key] : undefined;
		return clamp(c, own ?? (typeof c.width === "number" ? c.width : (content(c) ?? COLUMN_FALLBACK)));
	};
	const hidden = new Set<string>();
	const fit = () => {
		const shown = columns.filter((c) => !hidden.has(c.key));
		const widths: Record<string, number> = {};
		for (const c of shown) widths[c.key] = basis(c);
		const sum = () => shown.reduce((t, c) => t + widths[c.key], fixed);
		// Spread `amount` (positive: grow, negative: shrink) by weight, respecting limits.
		const spread = (amount: number, weightOf: (c: Column) => number) => {
			let left = amount;
			for (let pass = 0; pass < shown.length && Math.abs(left) > 0.5; pass++) {
				const open = shown.filter((c) => weightOf(c) > 0 && (left > 0 ? widths[c.key] < maxOf(c) : widths[c.key] > minOf(c)));
				const total = open.reduce((t, c) => t + weightOf(c), 0);
				if (!total) break;
				let used = 0;
				for (const c of open) {
					const next = clamp(c, widths[c.key] + (left * weightOf(c)) / total);
					used += next - widths[c.key];
					widths[c.key] = next;
				}
				left -= used;
			}
		};
		if (Number.isFinite(available)) {
			const gap = available - sum();
			if (gap > 0) spread(gap, growOf);
			else if (gap < 0) spread(gap, shrinkOf);
		}
		return { widths, total: sum() };
	};
	let result = fit();
	if (overflow === "hide" && Number.isFinite(available)) {
		const rank = (c: Column, i: number) => (c.priority ?? i) + (c.optional ? 1000 : 0);
		const candidates = columns
			.map((c, i) => ({ c, i, r: rank(c, i) }))
			.filter(({ c, i }) => i > 0 && !growOf(c))
			.sort((a, b) => b.r - a.r || b.i - a.i);
		for (const { c } of candidates) {
			if (result.total <= available + 0.5) break;
			hidden.add(c.key);
			result = fit();
		}
	}
	return { ...result, hidden };
}

/**
 * Can the edge after `columns[index]` be dragged? Between two columns it can when either side
 * can change width. After the last column only when nothing grows to fill the table: otherwise
 * that edge is the table's own edge.
 */
export function hasBoundary(columns: Column[], index: number): boolean {
	const left = columns[index];
	if (!left) return false;
	const flexible = (c: Column) => growOf(c) > 0 || isResizable(c);
	if (index === columns.length - 1) return isResizable(left) && !columns.some((c) => growOf(c));
	return flexible(left) && columns.slice(index + 1).some(flexible) && (isResizable(left) || columns.slice(index + 1).some((c) => !growOf(c) && isResizable(c)));
}

/**
 * Drag the edge after `columns[index]` by `delta` px from `widths` (the layout when the drag
 * began), so the edge stays under the pointer. Widening the left column takes the room after
 * the last column first (`spare`; Infinity when the table scrolls), then from the columns to the
 * right, nearest first, each down to its minimum. Narrowing it gives the room to the nearest
 * column on the right (up to its maximum), else to the space after the last column. Columns to
 * the left never move. Growing columns are not saved: the layout hands them what's left.
 * Returns the widths to save.
 */
export function dragBoundary(columns: Column[], widths: Record<string, number>, index: number, delta: number, spare = 0): Record<string, number> {
	const left = columns[index];
	const out: Record<string, number> = {};
	if (!left || !delta) return out;
	const right = columns.slice(index + 1).filter((c) => growOf(c) > 0 || isResizable(c));
	const w = (c: Column) => widths[c.key] ?? minOf(c);
	const saves = (c: Column) => !growOf(c) && isResizable(c);
	if (delta > 0) {
		const want = saves(left) ? Math.min(delta, maxOf(left) - w(left)) : growOf(left) ? delta : 0;
		let taken = Math.min(want, Math.max(0, spare));
		for (const c of right) {
			if (taken >= want) break;
			const give = Math.min(Math.max(0, w(c) - minOf(c)), want - taken);
			if (saves(c) && give) out[c.key] = Math.round(w(c) - give);
			taken += give;
		}
		if (saves(left) && taken) out[left.key] = Math.round(w(left) + taken);
	} else {
		const want = Math.max(0, Math.min(-delta, w(left) - minOf(left)));
		const next = right[0];
		let given = 0;
		if (next) {
			given = Math.min(want, growOf(next) ? want : maxOf(next) - w(next));
			if (saves(next) && given) out[next.key] = Math.round(w(next) + given);
		}
		// Nothing on the right can take it: the space after the last column does.
		if (saves(left)) given = want;
		if (saves(left) && given) out[left.key] = Math.round(w(left) - given);
	}
	return out;
}

/** What a person chose for a table: widths of the columns they resized, and their order. */
export type SavedLayout = { widths: Record<string, number>; order: string[] };

/** A saved layout from storage, keeping only well-formed parts (it may be old or edited). */
export function readSavedLayout(v: unknown): SavedLayout {
	const out: SavedLayout = { widths: {}, order: [] };
	if (!v || typeof v !== "object") return out;
	const { widths, order } = v as Record<string, unknown>;
	if (widths && typeof widths === "object" && !Array.isArray(widths))
		for (const [k, w] of Object.entries(widths)) if (typeof w === "number" && Number.isFinite(w) && w >= 0) out.widths[k] = w;
	if (Array.isArray(order)) out.order = order.filter((k): k is string => typeof k === "string");
	return out;
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

// ── dragging rows between sections (`reorder` tables) ───────────────────

/** Where a dragged row goes: into `section` (a section or sub-section id), before row `before` (null: the end, or the plugin's choice). */
export type RowMove = { rowId: string; section: string; before: string | null };

/**
 * The section a row is in, as drops name it ("" without a group): its sub-section's id inside
 * one of the table's declared `sections`, else its top-level group key.
 */
export function rowSection(row: Row, sections?: Section[]): string {
	const parents = subSectionParents(sections);
	const path = sectionGroup(row.group, parents);
	const depth = sectionDepth(path, parents);
	return depth ? groupKey(path[depth - 1]!) : "";
}

/** The group a row gets when it moves into `section`, keeping any groups it has inside its section. */
function withSection(group: Row["group"], section: string, sections: Section[]): Row["group"] {
	if (section === "") return undefined;
	const parents = subSectionParents(sections);
	const path = sectionGroup(group, parents);
	const inner = path.slice(sectionDepth(path, parents));
	return inner.length ? [section, ...inner] : section;
}

/** The rows with one moved, as the renderer shows them until the plugin answers. */
export function applyMove(rows: Row[], move: RowMove, sections: Section[] = []): Row[] {
	const moving = rows.find((r) => r.id === move.rowId);
	if (!moving) return rows;
	const rest = rows.filter((r) => r !== moving);
	const moved = rowSection(moving, sections) === move.section ? moving : { ...moving, group: withSection(moving.group, move.section, sections) };
	let at = move.before === null ? -1 : rest.findIndex((r) => r.id === move.before);
	if (at < 0) {
		const last = rest.map((r) => rowSection(r, sections)).lastIndexOf(move.section);
		at = last < 0 ? rest.length : last + 1;
	}
	return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/** A drop that leaves the row where it is. */
export function isNoopMove(rows: Row[], move: RowMove, sections: Section[] = []): boolean {
	const i = rows.findIndex((r) => r.id === move.rowId);
	if (i < 0) return true;
	const section = rowSection(rows[i]!, sections);
	if (section !== move.section) return false;
	if (move.before === move.rowId) return true;
	const after = rows.slice(i + 1).find((r) => rowSection(r, sections) === section);
	return move.before === null ? !after : after?.id === move.before;
}

/** What the pointer is over while dragging: a section or sub-section header, a top-level row (with the section it's in), or something else. */
export type DropSlot = { kind: "header"; section: string } | { kind: "row"; id: string; section: string } | { kind: "other" };

/**
 * The move a drop over `slots[index]` makes (in its `lower` half when `lower`). `whole` means the
 * section takes the row as a whole (a `"fixed"` section, highlighted rather than given a line).
 * null: the section refuses drops; undefined: not a drop place (keep the previous one).
 */
export function resolveDrop(slots: DropSlot[], index: number, lower: boolean, sections: Section[], rowId: string): (Omit<RowMove, "rowId"> & { whole: boolean }) | null | undefined {
	const slot = slots[index];
	if (!slot || slot.kind === "other") return undefined;
	const order = flatSections(sections).find((s) => s.id === slot.section)?.order ?? "manual";
	if (order === false) return null;
	if (order === "fixed") return { section: slot.section, before: null, whole: true };
	const nextRow = (from: number) => {
		for (let i = from; i < slots.length; i++) {
			const s = slots[i]!;
			if (s.kind === "header") return null;
			if (s.kind === "row" && s.id !== rowId) return s.section === slot.section ? s.id : null;
		}
		return null;
	};
	if (slot.kind === "header") return { section: slot.section, before: nextRow(index + 1), whole: false };
	return { section: slot.section, before: lower ? nextRow(index + 1) : slot.id, whole: false };
}
