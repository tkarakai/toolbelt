// UI state that belongs to the renderer, not the plugin: filter text, expanded rows, the
// selected row, scroll positions… Kept per surface, so switching tools and back finds things as
// they were — and saved (localStorage), so closing the window or quitting doesn't forget them.
// Best effort: a row that's gone is simply not selected. `usePersisted` is for layout choices
// that aren't per surface (widths).
import { createContext, useCallback, useContext, useEffect, useState } from "react";

const STORE = "toolbelt.ui";
const session = new Map<string, unknown>(load());
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function load(): [string, unknown][] {
	try {
		const raw = localStorage.getItem(STORE);
		return raw ? (Object.entries(JSON.parse(raw)) as [string, unknown][]) : [];
	} catch {
		return [];
	}
}

function save() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		try {
			localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(session)));
		} catch {}
	}, 300);
}

/** Read or write a surface's UI state outside React (scroll positions). */
export const uiState = {
	get: <T,>(surface: string, name: string): T | undefined => session.get(`${surface}\n${name}`) as T | undefined,
	set: (surface: string, name: string, value: unknown) => {
		session.set(`${surface}\n${name}`, value);
		save();
	},
};

/** `<plugin>/<surface>` of the surface being rendered. */
export const SurfaceContext = createContext("");

type Set<T> = (next: T | ((prev: T) => T)) => void;

export function useUIState<T>(name: string, initial: T): [T, Set<T>] {
	const surface = useContext(SurfaceContext);
	const key = `${surface}\n${name}`;
	const [value, setValue] = useState<T>(() => (session.has(key) ? (session.get(key) as T) : initial));
	const set = useCallback<Set<T>>(
		(next) =>
			setValue((prev) => {
				const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
				session.set(key, v);
				save();
				return v;
			}),
		[key],
	);
	return [value, set];
}

export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? initial : (JSON.parse(raw) as T);
		} catch {
			return initial;
		}
	});
	const set = useCallback(
		(v: T) => {
			setValue(v);
			try {
				localStorage.setItem(key, JSON.stringify(v));
			} catch {}
		},
		[key],
	);
	return [value, set];
}

/**
 * True while only the given modifiers are held (default ⌘; instantly, or after `delay` ms) — for
 * showing shortcut hints. Any other key, or letting go, hides them.
 */
export function useHeldModifiers(want: { meta?: boolean; alt?: boolean } = { meta: true }, delay = 0): boolean {
	const [held, setHeld] = useState(false);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const matches = (e: KeyboardEvent) => e.metaKey === !!want.meta && e.altKey === !!want.alt && !e.ctrlKey && !e.shiftKey;
		const reset = () => {
			clearTimeout(timer);
			timer = undefined;
			setHeld(false);
		};
		const down = (e: KeyboardEvent) => {
			const isModifier = e.key === "Meta" || e.key === "Alt";
			if (isModifier && matches(e)) {
				if (delay === 0) setHeld(true);
				else if (!timer) timer = setTimeout(() => setHeld(true), delay);
			} else reset();
		};
		const up = (e: KeyboardEvent) => {
			if (!matches(e)) reset();
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", reset);
		return () => {
			reset();
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", reset);
		};
	}, [want.meta, want.alt, delay]);
	return held;
}

/** Keyboard events that shouldn't drive lists: typing in a field, or inside a menu/dialog. */
export const isTyping = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]");
