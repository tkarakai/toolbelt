// The keyboard platform every surface shares. Use these instead of ad-hoc listeners:
//
// - `ownsKey(e)`: the focused widget (a text field, tabs, a radio group, a menu…) handles this key
//   itself, so page shortcuts and collections must leave it alone.
// - `overlayOpen()`: a dialog, menu or picker has the keyboard.
// - `useWindowKeys(handler)`: a window keydown listener that always sees the latest handler.
// - `useRovingFocus(ref, …)`: one Tab stop for a group of buttons; arrows (2-D for wrapping
//   grids), Home and End move between them.
// - `<FocusRegions />`: F6 / ⇧F6 cycle through the window's `[data-focus-region]`s, coming back to
//   where focus last was in each.
// - `<FocusRescue />`: when the focused element disappears (a row deleted, a menu's trigger
//   re-rendered away), focus goes to the nearest sensible place instead of the page body.
// - `focusRegion(el)` / `firstFocusable(el)`: where keyboard focus goes inside a container;
//   `focusIsIdle(el)`: nothing in particular has it, so a new screen may take it.
// - `itemDomId`: ids for `aria-activedescendant` on collections.
// - `<TabbableControls />`: buttons, links and pop-up buttons take Tab whatever macOS's Keyboard
//   navigation setting says (WebKit skips them while it's off).
// - `<FocusHint />`: a control with `data-key-hint="…"` shows that text beside it while it has
//   keyboard focus, for controls whose keys aren't obvious (column headers, resize edges).
// - `ResizeHandle` (components/resize-handle.tsx) and `ariaShortcut` (keys.ts) round it off.
//
// Visible focus: every control shows `:focus-visible` (index.css). Collections (tables, lists)
// keep DOM focus on their container and show the selected item; with nothing selected the
// container shows the ring instead, and any arrow selects an item.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { claims, nearestInDirection, stepIndex, widgetKeys, type Direction } from "./keys";

/** Dialogs, menus and pickers: while one is open, the page underneath gets no keys. */
export const OVERLAY = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox]:not([data-navigation-collection])";
/** Our own keyboard collections (tables, lists): they hold DOM focus on their container. */
export const COLLECTION = "[data-navigation-collection]";
/** Window regions F6 moves between (sidebar, header, content, drawer). */
export const REGION = "[data-focus-region]";
/** Focusable controls, in tab order candidates. */
export const FOCUSABLE = "a[href], button:not(:disabled), input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [contenteditable=true], [tabindex]:not([tabindex='-1'])";

export const overlayOpen = () => !!document.querySelector(OVERLAY);

const orientationOf = (el: Element) => {
	const own = el.getAttribute("aria-orientation") ?? el.getAttribute("data-orientation");
	if (own) return own;
	const group = el.closest("[role=tablist], [role=radiogroup], [role=toolbar]");
	return group?.getAttribute("aria-orientation") ?? group?.getAttribute("data-orientation") ?? (el.getAttribute("role") === "tab" || el.getAttribute("role") === "tablist" ? "horizontal" : null);
};

/** The keys an element handles itself (see `widgetKeys`). */
export function keysOf(el: Element): ReturnType<typeof widgetKeys> {
	const html = el as HTMLElement;
	return widgetKeys({
		tag: el.tagName,
		type: el instanceof HTMLInputElement ? el.type : undefined,
		role: el.getAttribute("role"),
		orientation: orientationOf(el),
		editable: html.isContentEditable,
	});
}

/**
 * True when the focused element (or a widget around it, up to `boundary`) handles this key
 * itself. Our own collections are skipped: they share the page's keys by ownership rules
 * (`ownsCollectionKeyboard`), not by claiming them.
 */
export function ownsKey(e: KeyboardEvent | React.KeyboardEvent, boundary?: Element | null): boolean {
	let el = e.target instanceof Element ? e.target : null;
	if (el?.closest(".xterm")) return true;
	for (; el && el !== boundary && el !== document.body; el = el.parentElement) {
		if (el.matches(COLLECTION)) continue;
		if (claims(keysOf(el), e)) return true;
	}
	return false;
}

/** Visible, not inert, not inside a closed (`hidden`/`aria-hidden`) part. */
export const isShown = (el: Element) => !!el.getClientRects().length && !el.closest("[inert], [hidden], [aria-hidden=true]");

/** Resize edges are focusable, but nobody arrives somewhere to resize it first. */
const control = (el: HTMLElement) => isShown(el) && el.getAttribute("role") !== "separator";
/** The first focusable control inside `root` that's shown (resize edges aside). */
export const firstFocusable = (root: Element) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(control);
/** The current item of a group: the active tab, the selected radio, the current tool. */
const CURRENT = "[role=tab][aria-selected=true], [role=radio][aria-checked=true], [aria-current=page], [aria-current=true], [data-active=true]";

/**
 * Where the keyboard goes when it enters a container: an explicit `[data-region-default]`, the
 * collection with a selection, the first table, the current item (active tab, checked radio,
 * current tool), the container itself when it takes focus (a scrolling content region), the first
 * control, else the container. Nested focus regions are left to themselves.
 */
export function focusTarget(root: HTMLElement): HTMLElement {
	const home = root.closest(REGION);
	const own = (el: Element) => el.closest(REGION) === home;
	const pick = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => control(el) && own(el));
	const explicit = pick("[data-region-default]")[0];
	if (explicit) return explicit;
	const collections = pick(COLLECTION);
	const selected = collections.find((c) => c.querySelector("[data-active=true], [data-selected=true]"));
	const table = collections.find((c) => c.matches("[data-table-focus]"));
	const current = pick(CURRENT).find((el) => el.matches(FOCUSABLE) || el.getAttribute("role") === "tab");
	const itself = root.getAttribute("tabindex") === "0" ? root : undefined;
	return selected ?? table ?? current ?? itself ?? collections[0] ?? pick(FOCUSABLE)[0] ?? root;
}

export function focusRegion(root: HTMLElement) {
	const target = focusTarget(root);
	if (target === root && !root.hasAttribute("tabindex")) root.tabIndex = -1;
	target.focus({ preventScroll: target === root });
}

/** Focus is nowhere in particular: on the page body, or on the region holding `within` itself
 *  (not on one of its controls). A new screen or collection may then take it. */
export function focusIsIdle(within: Element | null) {
	const active = document.activeElement;
	return !active || active === document.body || active === document.documentElement || (active.matches(REGION) && !!within && active.contains(within));
}

const SCROLL_KEYS: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: 0.9, PageUp: -0.9, " ": 0.9 };
/** The element that scrolls a region's content, when the region itself doesn't. */
function scrollerOf(region: HTMLElement): HTMLElement | null {
	const scrolls = (el: HTMLElement) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
	if (scrolls(region)) return null;
	return [...region.querySelectorAll<HTMLElement>("*")].find((el) => scrolls(el) && el.closest(REGION) === region && !el.closest(COLLECTION)) ?? null;
}

/** A window keydown listener that always calls the latest `handler` (no dependency lists). */
export function useWindowKeys(handler: (e: KeyboardEvent) => void, { capture = false, enabled = true }: { capture?: boolean; enabled?: boolean } = {}) {
	const latest = useRef(handler);
	latest.current = handler;
	useEffect(() => {
		if (!enabled) return;
		const on = (e: KeyboardEvent) => latest.current(e);
		window.addEventListener("keydown", on, capture);
		return () => window.removeEventListener("keydown", on, capture);
	}, [capture, enabled]);
}

/**
 * One Tab stop for a group of controls (a toolbar, a radio group of cards, a menu-like list):
 * the current item is tabbable, arrows/Home/End move focus between items. `orientation: "grid"`
 * moves by geometry, for wrapping grids. `selectOnFocus` activates an item as focus reaches it
 * (radio groups). Returns the container's keydown handler.
 */
export function useRovingFocus<T extends HTMLElement>(ref: RefObject<T | null>, { items = "[data-roving-item]", orientation = "vertical", loop = false, current = "[aria-checked=true], [aria-pressed=true], [aria-current=page], [aria-current=true], [data-active=true]", selectOnFocus = false }: { items?: string; orientation?: "vertical" | "horizontal" | "both" | "grid"; loop?: boolean; current?: string; selectOnFocus?: boolean } = {}) {
	const list = () => [...(ref.current?.querySelectorAll<HTMLElement>(items) ?? [])].filter((el) => isShown(el) && !(el as HTMLButtonElement).disabled);
	// Exactly one item is tabbable: the focused one, else the current one, else the first.
	const sync = () => {
		const all = list();
		const focused = all.find((el) => el === document.activeElement || el.contains(document.activeElement));
		const active = focused ?? all.find((el) => el.matches(current)) ?? all.find((el) => el.tabIndex === 0) ?? all[0];
		for (const el of all) el.tabIndex = el === active ? 0 : -1;
	};
	const latest = useRef(sync);
	latest.current = sync;
	useLayoutEffect(sync);
	// Items can change without this component rendering (their own state, a new plugin tree).
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		let frame = 0;
		const later = () => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(() => latest.current())));
		const now = () => latest.current();
		const observer = new MutationObserver(later);
		observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "aria-pressed", "aria-current", "data-active", "disabled"] });
		root.addEventListener("focusin", now);
		return () => (cancelAnimationFrame(frame), observer.disconnect(), root.removeEventListener("focusin", now));
	}, [ref]);
	return (e: React.KeyboardEvent) => {
		if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
		const all = list();
		const from = all.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
		if (from < 0) return;
		let to: number | null;
		if (orientation === "grid") {
			const dir = ({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" } as Record<string, Direction>)[e.key];
			to = dir ? nearestInDirection(all.map((el) => el.getBoundingClientRect()), from, dir) : stepIndex(all.length, from, e.key, "both");
		} else to = stepIndex(all.length, from, e.key, orientation, loop);
		if (to === null) return;
		e.preventDefault();
		e.stopPropagation();
		const next = all[to]!;
		next.focus();
		next.scrollIntoView({ block: "nearest", inline: "nearest" });
		if (selectOnFocus && to !== from) next.click();
	};
}

// ── F6: move between the window's regions ──────────────────────────────────
const remembered = new WeakMap<HTMLElement, HTMLElement>();

/** F6 / ⇧F6 cycle through the window's regions (sidebar, header, content, drawer), returning
 *  to where focus last was in each. Mount once per window. */
export function FocusRegions() {
	useEffect(() => {
		const onFocus = (e: FocusEvent) => {
			const el = e.target instanceof HTMLElement ? e.target : null;
			const region = el?.closest<HTMLElement>(REGION);
			if (el && region && el !== region && el.getAttribute("role") !== "separator") remembered.set(region, el);
		};
		const onKey = (e: KeyboardEvent) => {
			// A focused region scrolls its content with the usual keys, even when the scrolling
			// element is inside it (a page's column). A screen's table takes those keys instead.
			const target = e.target instanceof HTMLElement ? e.target : null;
			if (target?.matches(REGION) && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key in SCROLL_KEYS || e.key === "Home" || e.key === "End")
				&& ![...target.querySelectorAll("[data-table-focus]")].some(isShown)) {
				const scroller = scrollerOf(target);
				if (scroller) {
					e.preventDefault();
					const amount = SCROLL_KEYS[e.key];
					if (e.key === "Home" || e.key === "End") scroller.scrollTo({ top: e.key === "Home" ? 0 : scroller.scrollHeight });
					else scroller.scrollBy({ top: Math.abs(amount!) < 1 ? amount! * scroller.clientHeight * (e.shiftKey && e.key === " " ? -1 : 1) : amount });
					return;
				}
			}
			if (e.key !== "F6" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
			const scope = (document.activeElement?.closest<HTMLElement>(OVERLAY)) ?? document;
			const regions = [...scope.querySelectorAll<HTMLElement>(REGION)].filter(isShown);
			if (!regions.length) return;
			e.preventDefault();
			const at = regions.findIndex((r) => r === document.activeElement?.closest(REGION));
			const next = regions[(at + (e.shiftKey ? -1 : 1) + regions.length + (at < 0 && e.shiftKey ? 1 : 0)) % regions.length]!;
			const last = remembered.get(next);
			if (last?.isConnected && isShown(last) && last.closest(REGION) === next) last.focus();
			else focusRegion(next);
		};
		document.addEventListener("focusin", onFocus);
		window.addEventListener("keydown", onKey);
		return () => (document.removeEventListener("focusin", onFocus), window.removeEventListener("keydown", onKey));
	}, []);
	return null;
}

// ── focus rescue ───────────────────────────────────────────────────────────
/** Places focus can fall back to, nearest first, when the focused element goes away. */
const ANCHORS = `${COLLECTION}, [data-keyboard-pane], ${REGION}, [role=dialog]`;

/**
 * When the focused element is removed, disabled or hidden (its row deleted, its menu closed with
 * the trigger gone, a screen switched under it), the browser drops focus on the page body and
 * the keyboard is lost. This puts it back at the nearest surviving anchor (its collection, pane,
 * region or dialog), else the main content. Mount once per window.
 */
export function FocusRescue({ fallback = "[data-focus-region=content]" }: { fallback?: string }) {
	useEffect(() => {
		let anchors: HTMLElement[] = [];
		let last: HTMLElement | null = null;
		let frame = 0;
		const onFocus = (e: FocusEvent) => {
			if (!(e.target instanceof HTMLElement)) return;
			last = e.target;
			anchors = [];
			for (let el = e.target.parentElement?.closest<HTMLElement>(ANCHORS); el; el = el.parentElement?.closest<HTMLElement>(ANCHORS) ?? null) anchors.push(el);
		};
		const lost = (el: HTMLElement) => !el.isConnected || (el as HTMLButtonElement).disabled || !isShown(el);
		let waits = 0;
		const check = () => {
			if (!last || !document.hasFocus()) return;
			// A dialog or menu still animating out gives focus back itself when it's gone.
			if (document.querySelector("[role=dialog][data-state=closed], [role=menu][data-state=closed]") && waits++ < 12) return void setTimeout(check, 50);
			waits = 0;
			const active = document.activeElement;
			if (active && active !== document.body && active !== document.documentElement) return;
			if (!lost(last)) return;
			const anchor = anchors.find((a) => a.isConnected && isShown(a)) ?? document.querySelector<HTMLElement>(fallback);
			last = null;
			if (anchor && isShown(anchor)) focusRegion(anchor);
		};
		const onBlur = () => {
			cancelAnimationFrame(frame);
			// After menus and dialogs have put focus back (they do so on the next tick).
			frame = requestAnimationFrame(() => (frame = requestAnimationFrame(check)));
		};
		// Removal fires no focusout in every engine: watch for the focused element leaving too.
		const observer = new MutationObserver(() => { if (last && !last.isConnected) onBlur(); });
		observer.observe(document.body, { childList: true, subtree: true });
		document.addEventListener("focusin", onFocus);
		document.addEventListener("focusout", onBlur);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("focusout", onBlur);
		};
	}, [fallback]);
	return null;
}

/** A DOM id for a collection item (any string id), for `aria-activedescendant`. */
export const itemDomId = (prefix: string, id: string) => `${prefix}-${encodeURIComponent(id)}`;

// ── reach every control with Tab ───────────────────────────────────────────
/** Controls WebKit leaves out of the Tab order unless macOS's Keyboard navigation is on. */
const SKIPPED = "button:not([tabindex]), a[href]:not([tabindex]), summary:not([tabindex]), select:not([tabindex]), input:is([type=checkbox], [type=radio], [type=range], [type=color], [type=file], [type=button], [type=submit], [type=reset]):not([tabindex])";

/**
 * WKWebView follows macOS's “Keyboard navigation” setting, off by default: Tab then stops only
 * at text fields and elements with an explicit `tabindex`, skipping every button, link and
 * pop-up button. An explicit `tabindex="0"` puts them back, so the app is keyboard-usable on
 * every Mac. Elements that set their own `tabindex` (roving groups, `-1` for out-of-order
 * controls) are left alone. Mount once per window.
 */
export function TabbableControls() {
	useEffect(() => {
		const apply = (root: ParentNode) => root.querySelectorAll<HTMLElement>(SKIPPED).forEach((el) => el.setAttribute("tabindex", "0"));
		apply(document);
		const observer = new MutationObserver((records) => {
			for (const r of records) {
				if (r.type === "attributes") {
					const el = r.target as HTMLElement;
					if (el.matches(SKIPPED)) el.setAttribute("tabindex", "0");
				} else r.addedNodes.forEach((n) => n instanceof HTMLElement && (n.matches(SKIPPED) ? n.setAttribute("tabindex", "0") : undefined, apply(n)));
			}
		});
		observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["tabindex", "href"] });
		return () => observer.disconnect();
	}, []);
	return null;
}

// ── focus hints ────────────────────────────────────────────────────────────
/** While a control with `data-key-hint` has keyboard focus, its hint shows beside it (and is
 *  its accessible description). Mount once per window. */
export function FocusHint() {
	const [hint, setHint] = useState<{ text: string; el: HTMLElement } | null>(null);
	const [box, setBox] = useState<{ left: number; top: number; above: boolean } | null>(null);
	useEffect(() => {
		const onIn = (e: FocusEvent) => {
			const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-key-hint]") : null;
			setHint(el && el === e.target && el.matches(":focus-visible") ? { text: el.dataset.keyHint!, el } : null);
		};
		const onOut = () => setHint(null);
		document.addEventListener("focusin", onIn);
		document.addEventListener("focusout", onOut);
		return () => (document.removeEventListener("focusin", onIn), document.removeEventListener("focusout", onOut));
	}, []);
	useLayoutEffect(() => {
		if (!hint) return setBox(null);
		const place = () => {
			if (!hint.el.isConnected) return setHint(null);
			const r = hint.el.getBoundingClientRect();
			const above = r.bottom + 36 > window.innerHeight;
			setBox({ left: Math.max(8, Math.min(window.innerWidth - 8, r.left + r.width / 2)), top: above ? r.top - 6 : r.bottom + 6, above });
		};
		place();
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => (window.removeEventListener("scroll", place, true), window.removeEventListener("resize", place));
	}, [hint]);
	if (!hint || !box) return null;
	return createPortal(
		<div role="presentation" aria-hidden="true" style={{ left: box.left, top: box.top, transform: `translate(-50%, ${box.above ? "-100%" : "0"})` }}
			className="pointer-events-none fixed z-[60] max-w-80 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md animate-in fade-in-0 duration-200">
			{hint.text}
		</div>,
		document.body,
	);
}

// ── dialogs: the default action ────────────────────────────────────────────
const MULTILINE = "textarea, [contenteditable=true], .tb-terminal";
/** Fields whose ↵ belongs to the dialog's default button, as in macOS dialogs: pickers open with
 *  Space (or ↓), toggles flip with Space. */
const RETURN_SUBMITS = "[role=combobox]:not([aria-expanded=true]), [role=switch], [role=checkbox], [role=radio], input[type=checkbox], input[type=radio]";
const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "file", "color", "range", "image"]);

/**
 * A dialog's default action, the macOS way: ↵ runs it from anywhere in the dialog (one-line
 * fields commit first, pickers and toggles leave ↵ to it), except in multi-line text, where ↵ is a
 * new line, and on another button, which ↵ presses. ⌘↵ runs it from anywhere, editors included.
 * `hint` is the key to show on the default button: "⌘↵" while focus is in multi-line text. Spread
 * `handlers` on the dialog's content. With no `run` (no default action, or it's disabled), keys
 * keep their usual meaning, so ↵ on a picker opens it.
 */
export function useDefaultAction(run: (() => void) | undefined) {
	const [multiline, setMultiline] = useState(false);
	const inside = (e: React.SyntheticEvent) => e.currentTarget.contains(e.target as Node);
	const fire = (e: React.KeyboardEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Fields send their value on blur: commit what's being typed before the action.
		(e.target as HTMLElement).blur?.();
		run!();
	};
	const plain = (e: React.KeyboardEvent) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.nativeEvent.isComposing;
	const handlers = {
		onKeyDownCapture: (e: React.KeyboardEvent) => {
			if (!run || !inside(e) || e.nativeEvent.isComposing) return;
			const target = e.target as HTMLElement;
			// ⌘↵ from anywhere; ↵ on a picker or toggle before the control opens or flips itself.
			if (e.key === "Enter" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return fire(e);
			if (plain(e) && target.matches(RETURN_SUBMITS)) fire(e);
		},
		onKeyDown: (e: React.KeyboardEvent) => {
			if (!run || e.defaultPrevented || !inside(e) || !plain(e)) return;
			const target = e.target as HTMLElement;
			const oneLine = target instanceof HTMLInputElement && !NOT_TEXT.has(target.type);
			if (!oneLine && target.closest(`button, a, select, [role=menuitem], [role=option], ${MULTILINE}`)) return;
			fire(e);
		},
		onFocusCapture: (e: React.FocusEvent) => setMultiline(!!(e.target as HTMLElement).closest(MULTILINE)),
	};
	return { handlers, hint: multiline ? "⌘↵" : "↵", ariaKeys: multiline ? "Meta+Enter" : "Enter Meta+Enter" };
}
