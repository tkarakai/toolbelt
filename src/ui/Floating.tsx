// Floating plugins (manifest `floating`, capability `ui.floating`): a window over the main screen
// that the person moves, resizes and minimizes into its sidebar item, at the bottom of the
// sidebar above Settings. Windows aren't modal: clicks and keys outside them reach the screen
// below, so they're regions, never `role=dialog` (which tells the rest of the window to stand
// back). The plugin renders a `floating` node: an ask bar (`mode: "bar"`) or a panel with a
// title bar. Frames (position, size, open), stacking and focus are renderer state; frames are
// remembered per profile. On a phone, one floating plugin at a time shows as a bottom sheet. The
// menu-bar popover doesn't list floating plugins: they belong with the screens they float over.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ChevronsUpDown, GripVertical, Loader2, Minus, Sparkles, X } from "lucide-react";
import type { Node, Suggestion } from "../shared/protocol";
import type { PluginInfo } from "../shared/rpc";
import { payloadFor } from "../shared/actions";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { sendEvent, useNavigate, useSurface } from "@/lib/store";
import { SurfaceContext, usePersisted, useUIState } from "@/lib/uistate";
import { overlayOpen } from "@/lib/keyboard";
import { useSheetDrag } from "@/lib/touch";
import { SafeRender as Render } from "@/renderer/SafeRender";
import { When } from "@/renderer/Render";
import { FloatingSurface } from "@/renderer/floating-context";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutTooltip } from "@/components/shortcut-tooltip";
import { keyboardInset } from "@/hooks/use-keyboard-inset";
import { SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";

type FloatingNode = Extract<Node, { type: "floating" }>;
/** Where a window sits: `x` from the left and `bottom` from the bottom of the window, so an ask
 *  bar stays at the bottom and a panel grows upward from it. `h` is the panel's height. */
type Frame = { x: number; bottom: number; w: number; h: number; open: boolean };
/** What's remembered: whether it's open, and its place once the person moved or resized it. */
type Saved = Partial<Frame> & { open: boolean };
const BAR_W = 540;
const PANEL_W = 360;
const PANEL_H = 440;
const MIN_BAR_W = 360;
const MIN_W = 260;
const MIN_H = 160;
const MARGIN = 24;
const SURFACE = "floating";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const shortcutOf = (p: PluginInfo) => p.manifest.floating?.shortcut;
const keysOf = (p: PluginInfo) => (shortcutOf(p) ? `⌘${shortcutOf(p)!.toUpperCase()}` : undefined);

type Floating = {
	plugins: PluginInfo[];
	/** A window's frame; until the person places it, the default for its mode. */
	frame(id: string, mode?: "bar" | "panel"): Frame;
	setFrame(id: string, frame: Partial<Frame>): void;
	/** Remembers where a window first showed, so switching between bar and panel keeps its place. */
	place(id: string, frame: Frame): void;
	/** Open windows, back to front. */
	order: string[];
	/** The window that has the keyboard, if any. */
	focus: string | null;
	unread: Record<string, boolean>;
	/** Sidebar item and shortcut: minimized → opens; behind or unfocused → front; in front → minimizes. */
	toggle(id: string): void;
	open(id: string): void;
	minimize(id: string): void;
	raise(id: string): void;
	setFocus(id: string | null): void;
	busyChanged(id: string, busy: boolean): void;
	/** Phone: the floating plugin whose sheet shows, and whether it's open. */
	sheet: { id: string | null; open: boolean };
};

const Ctx = createContext<Floating | null>(null);
export const useFloating = () => useContext(Ctx);

/** Where a new window goes: an ask bar centered at the bottom of the main area, a panel at its right. */
function defaultFrame(mode: "bar" | "panel"): Omit<Frame, "open"> {
	const inset = document.querySelector<HTMLElement>("[data-slot=sidebar-inset]")?.getBoundingClientRect();
	const left = inset?.left ?? 0;
	const width = inset?.width ?? window.innerWidth;
	if (mode === "panel") return { x: Math.round(left + width - PANEL_W - MARGIN), bottom: MARGIN, w: PANEL_W, h: PANEL_H };
	const w = Math.min(BAR_W, width - 2 * MARGIN);
	return { x: Math.round(left + (width - w) / 2), bottom: MARGIN, w, h: PANEL_H };
}

/** Keeps a frame inside the window. */
function clamp(f: Frame, height: number): Frame {
	const vw = window.innerWidth, vh = window.innerHeight;
	const w = Math.max(Math.min(f.w, vw - 16), Math.min(MIN_W, vw - 16));
	const h = Math.min(f.h, vh - 16);
	return { ...f, w, h, x: Math.max(0, Math.min(vw - w, f.x)), bottom: Math.max(0, Math.min(vh - Math.min(height, vh), f.bottom)) };
}

export function FloatingProvider({ plugins, children }: { plugins: PluginInfo[]; children: ReactNode }) {
	const floating = useMemo(() => plugins.filter((p) => !!p.manifest.floating), [plugins]);
	const [frames, saveFrames] = usePersisted<Record<string, Saved>>("toolbelt.floating", {});
	const framesRef = useRef(frames);
	framesRef.current = frames;
	const [order, setOrder] = useState<string[]>(() => Object.entries(frames).filter(([, f]) => f.open).map(([id]) => id));
	const [focus, setFocus] = useState<string | null>(null);
	const [unread, setUnread] = useState<Record<string, boolean>>({});
	const [sheet, setSheet] = usePersisted<{ id: string | null; open: boolean }>("toolbelt.floatingSheet", { id: null, open: false });
	const { isMobile, setOpenMobile } = useSidebar();
	const busy = useRef<Record<string, boolean>>({});

	const frame = useCallback((id: string, mode: "bar" | "panel" = "bar"): Frame => {
		const saved = framesRef.current[id];
		const placed = saved?.x !== undefined && saved.bottom !== undefined && saved.w !== undefined && saved.h !== undefined;
		return { ...defaultFrame(mode), ...(placed ? saved : {}), open: !!saved?.open };
	}, []);
	const setFrame = useCallback((id: string, next: Partial<Frame>) => {
		framesRef.current = { ...framesRef.current, [id]: { ...framesRef.current[id], open: !!framesRef.current[id]?.open, ...next } };
		saveFrames(framesRef.current);
	}, [saveFrames]);
	const place = useCallback((id: string, f: Frame) => {
		if (framesRef.current[id]?.x === undefined) setFrame(id, { x: f.x, bottom: f.bottom, w: f.w, h: f.h });
	}, [setFrame]);
	const raise = useCallback((id: string) => setOrder((o) => (o[o.length - 1] === id ? o : [...o.filter((x) => x !== id), id])), []);

	const open = useCallback((id: string) => {
		if (isMobile) {
			setSheet({ id, open: true });
			setOpenMobile(false);
		} else {
			if (!frame(id).open) restoring.add(id);
			setFrame(id, { open: true });
			raise(id);
			setFocus(id);
			focusWindow(id);
		}
		setUnread((u) => (u[id] ? { ...u, [id]: false } : u));
	}, [isMobile, frame, setFrame, raise, setSheet, setOpenMobile]);

	const minimize = useCallback((id: string) => {
		const done = () => {
			setFrame(id, { open: false });
			setOrder((o) => o.filter((x) => x !== id));
			setFocus((f) => (f === id ? null : f));
		};
		if (isMobile) return setSheet({ id, open: false });
		const el = document.querySelector<HTMLElement>(`[data-floating-window="${CSS.escape(id)}"]`);
		const item = document.querySelector<HTMLElement>(`[data-floating-item="${CSS.escape(id)}"]`);
		// The window shrinks into its sidebar item.
		const shrink = el && item && !reducedMotion() ? genieAnimation(el, item, "out") : null;
		if (shrink && el && item) {
			el.style.pointerEvents = "none";
			shrink.onfinish = () => {
				done();
				item.animate([{ backgroundColor: "var(--accent)" }, { backgroundColor: "transparent" }], { duration: 400, easing: "ease-out" });
			};
		} else done();
		// The keyboard goes back to the screen below.
		if (el?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
	}, [isMobile, setFrame, setSheet]);

	const toggle = useCallback((id: string) => {
		if (isMobile) return sheet.open && sheet.id === id ? setSheet({ id, open: false }) : open(id);
		if (!frame(id).open) return open(id);
		if (order[order.length - 1] !== id || focus !== id) {
			raise(id);
			setFocus(id);
			focusWindow(id);
			return;
		}
		minimize(id);
	}, [isMobile, sheet, setSheet, open, frame, order, focus, raise, minimize]);

	// A reply that finishes while the window is minimized marks its item until it opens.
	const busyChanged = useCallback((id: string, now: boolean) => {
		const was = busy.current[id];
		busy.current[id] = now;
		const hidden = isMobile ? !(sheet.open && sheet.id === id) : !framesRef.current[id]?.open;
		if (was && !now && hidden) setUnread((u) => ({ ...u, [id]: true }));
	}, [isMobile, sheet]);

	// ⌘ + a floating plugin's letter, from anywhere in the window but Settings (which keeps its own).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.defaultPrevented || location.hash.startsWith("#/toolbelt")) return;
			const p = floating.find((x) => shortcutOf(x) === e.key.toLowerCase());
			if (!p) return;
			if (overlayOpen() && !document.activeElement?.closest("[data-floating-window]")) return;
			e.preventDefault();
			e.stopPropagation();
			toggle(p.manifest.id);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [floating, toggle]);

	// Clicking outside the floating windows gives the keyboard back to the screen below.
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			if (!(e.target as Element | null)?.closest?.("[data-floating-window], [data-floating-item]")) setFocus(null);
		};
		window.addEventListener("pointerdown", onDown, true);
		return () => window.removeEventListener("pointerdown", onDown, true);
	}, []);

	// Navigation to a floating plugin without screens (such as a notification's) opens its window.
	useNavigate(useCallback((plugin: string) => {
		const p = floating.find((x) => x.manifest.id === plugin);
		if (p && !p.manifest.screens.length) open(plugin);
	}, [floating, open]));

	// Plugins that went away leave the stack.
	useEffect(() => setOrder((o) => o.filter((id) => floating.some((p) => p.manifest.id === id))), [floating]);

	const value: Floating = { plugins: floating, frame, setFrame, place, order, focus, unread, toggle, open, minimize, raise, setFocus, busyChanged, sheet: { id: sheet.id && floating.some((p) => p.manifest.id === sheet.id) ? sheet.id : (floating[0]?.manifest.id ?? null), open: sheet.open } };
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Windows that should animate out of their sidebar item when they next mount. */
const restoring = new Set<string>();

/** The transform that shrinks a window onto its sidebar item's icon (around the window's center,
 *  its default transform origin), or null when the item isn't on screen. */
function genie(el: HTMLElement, item: HTMLElement) {
	const icon = item.querySelector("svg") ?? item;
	const a = el.getBoundingClientRect(), b = icon.getBoundingClientRect();
	if (!b.width || !b.height || !a.width || !a.height) return null;
	const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
	return `translate(${dx}px, ${dy}px) scale(${b.width / a.width}, ${b.height / a.height})`;
}

/** A window growing out of its sidebar icon, or shrinking back into it. It stays opaque for most
 *  of the way so it reads as the same object. */
function genieAnimation(el: HTMLElement, item: HTMLElement, direction: "in" | "out") {
	const to = genie(el, item);
	if (!to) return null;
	const small = { transform: to, opacity: 0, borderRadius: "40px" };
	const full = { transform: "none", opacity: 1 };
	return direction === "out"
		? el.animate([full, { opacity: 1, offset: 0.55 }, small], { duration: 200, easing: "cubic-bezier(0.4, 0, 0.8, 0.6)", fill: "forwards" })
		: el.animate([small, { opacity: 1, offset: 0.4 }, full], { duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" });
}

/** Puts the keyboard in a window's input once it's on screen. */
function focusWindow(id: string) {
	requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			const root = document.querySelector<HTMLElement>(`[data-floating-window="${CSS.escape(id)}"], [data-floating-sheet="${CSS.escape(id)}"]`);
			const input = root?.querySelector<HTMLElement>("[data-floating-input], input:not([type=hidden]), textarea, [contenteditable=true]");
			(input ?? root)?.focus({ preventScroll: true });
		}),
	);
}

// ── sidebar ──────────────────────────────────────────────────────────────
/** Floating plugins at the bottom of the sidebar, above Settings. */
export function FloatingSidebarItems({ row, active }: { row: string; active: string }) {
	const f = useFloating();
	if (!f?.plugins.length) return null;
	return (
		<SidebarMenu data-floating-items aria-label="Floating tools" className="border-t border-sidebar-border pt-2">
			{f.plugins.map((p) => (
				<FloatingItem key={p.manifest.id} info={p} row={row} active={active} />
			))}
		</SidebarMenu>
	);
}

function FloatingItem({ info, row, active }: { info: PluginInfo; row: string; active: string }) {
	const f = useFloating()!;
	const { state, isMobile } = useSidebar();
	const id = info.manifest.id;
	const tree = useSurface(id, SURFACE);
	const busy = tree?.type === "floating" && !!tree.busy;
	const open = isMobile ? f.sheet.open && f.sheet.id === id : f.frame(id).open;
	const front = open && !isMobile && f.order[f.order.length - 1] === id && f.focus === id;
	const keys = keysOf(info);
	let right: ReactNode = null;
	if (busy && !open) right = <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Working" />;
	else if (f.unread[id]) right = <span className="size-2 rounded-full bg-violet-500" aria-label="New reply" />;
	else if (info.badge !== null && info.badge !== undefined) right = <span className="tabular-nums">{info.badge}</span>;
	else if (keys && !isMobile) right = <Kbd className="opacity-0 transition-opacity group-hover/menu-item:opacity-100">{keys}</Kbd>;
	return (
		<SidebarMenuItem>
			<ShortcutTooltip label={open ? (front ? `Minimize ${info.manifest.name}` : `Show ${info.manifest.name}`) : `Open ${info.manifest.name}`} keys={keys} side={state === "collapsed" ? "right" : "top"} align={state === "collapsed" ? "center" : "start"}>
				<SidebarMenuButton
					data-floating-item={id}
					aria-pressed={open}
					aria-keyshortcuts={shortcutOf(info) ? `Meta+${shortcutOf(info)!.toUpperCase()}` : undefined}
					onClick={() => f.toggle(id)}
					className={cn(row, "relative", front && active, "before:absolute before:top-1/2 before:left-0.5 before:h-3.5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-muted-foreground before:opacity-0 before:transition-[opacity,height] before:duration-200", open && "before:opacity-60", front && "before:h-[18px] before:bg-foreground before:opacity-100")}
				>
					<Icon name={info.manifest.icon} />
					<span className="truncate">{info.manifest.name}</span>
					{info.state !== "running" && <span className="ml-auto size-2 rounded-full bg-amber-500 group-data-[collapsible=icon]:hidden" />}
				</SidebarMenuButton>
			</ShortcutTooltip>
			{right && <SidebarMenuBadge className={cn("text-muted-foreground", isMobile && "top-1/2! -translate-y-1/2")}>{right}</SidebarMenuBadge>}
		</SidebarMenuItem>
	);
}

// ── windows ──────────────────────────────────────────────────────────────
/** Every floating plugin's window (desktop) or the sheet (phone). Mounted for every floating plugin,
 *  so a minimized window's plugin keeps its surface open and its sidebar item stays current. */
export function FloatingLayer() {
	const f = useFloating();
	const { isMobile } = useSidebar();
	if (!f?.plugins.length) return null;
	if (isMobile) return <FloatingSheet />;
	return (
		<div className="pointer-events-none fixed inset-0 z-40" data-floating-layer>
			{f.plugins.map((p) => (
				<FloatingWindow key={p.manifest.id} info={p} />
			))}
		</div>
	);
}

function useFloatingTree(info: PluginInfo) {
	const f = useFloating();
	const id = info.manifest.id;
	const tree = useSurface(id, SURFACE);
	const node: FloatingNode | null = tree?.type === "floating" ? tree : tree ? { type: "floating", mode: "panel", children: [tree] } : null;
	const busy = !!node?.busy;
	useEffect(() => f?.busyChanged(id, busy), [busy, id]); // eslint-disable-line react-hooks/exhaustive-deps
	const emit = useCallback((name: string, payload?: unknown) => sendEvent(id, SURFACE, name, payload), [id]);
	return { node, emit };
}

function FloatingWindow({ info }: { info: PluginInfo }) {
	const f = useFloating()!;
	const id = info.manifest.id;
	const { node, emit } = useFloatingTree(info);
	const mode = node?.mode ?? "bar";
	const stored = f.frame(id, mode);
	const root = useRef<HTMLDivElement>(null);
	const [live, setLive] = useState<Frame | null>(null); // while dragging or resizing
	const [, relayout] = useState(0);
	useEffect(() => {
		const on = () => relayout((n) => n + 1);
		window.addEventListener("resize", on);
		return () => window.removeEventListener("resize", on);
	}, []);
	const lastHeight = useRef(0);
	const lastMode = useRef(mode);
	const heightAnimation = useRef<Animation | null>(null);
	const frame = clamp(live ?? stored, mode === "bar" ? lastHeight.current || 56 : (live ?? stored).h);

	// Opening animates out of the sidebar item; switching between bar and panel animates the height.
	useLayoutEffect(() => {
		const el = root.current;
		if (!el) return;
		// A running height animation changes what offsetHeight reports: while one runs, its target
		// is the height (a mode switch in the middle of one starts from where it is).
		if (lastMode.current !== mode) heightAnimation.current?.cancel();
		const height = heightAnimation.current?.playState === "running" ? lastHeight.current : el.offsetHeight;
		if (restoring.delete(id) && !reducedMotion()) {
			const item = document.querySelector<HTMLElement>(`[data-floating-item="${CSS.escape(id)}"]`);
			if (item) genieAnimation(el, item, "in");
		} else if (lastMode.current !== mode && lastHeight.current) {
			if (!reducedMotion()) heightAnimation.current = el.animate([{ height: `${lastHeight.current}px` }, { height: `${height}px` }], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
			// The input was replaced: the keyboard stays in the window if it was there.
			if (f.focus === id && (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement))) focusWindow(id);
		}
		lastMode.current = mode;
		lastHeight.current = height;
		if (node) f.place(id, frame);
	});

	if (!stored.open) return null;
	const front = f.order[f.order.length - 1] === id;
	const focused = front && f.focus === id;
	const z = Math.max(0, f.order.indexOf(id));

	const startDrag = (e: React.PointerEvent, edges: string) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, textarea, a, [contenteditable=true]")) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		try {
			el.setPointerCapture(e.pointerId);
		} catch {}
		const start = { ...frame }, x0 = e.clientX, y0 = e.clientY;
		const minW = mode === "bar" ? MIN_BAR_W : MIN_W;
		let next = start;
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - x0, dy = ev.clientY - y0;
			next = { ...start };
			if (edges === "move") next = { ...start, x: start.x + dx, bottom: start.bottom - dy };
			else {
				if (edges.includes("e")) next.w = Math.max(minW, start.w + dx);
				if (edges.includes("w")) {
					const w = Math.max(minW, start.w - dx);
					next.x = start.x + (start.w - w);
					next.w = w;
				}
				if (mode === "panel" && edges.includes("n")) next.h = Math.max(MIN_H, start.h - dy);
				if (mode === "panel" && edges.includes("s")) {
					const h = Math.max(MIN_H, start.h + dy);
					next.bottom = start.bottom - (h - start.h);
					next.h = h;
				}
			}
			setLive(next);
		};
		const up = () => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", up);
			setLive(null);
			f.setFrame(id, clamp(next, mode === "bar" ? lastHeight.current : next.h));
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", up);
	};

	return (
		<section
			ref={root}
			data-floating-window={id}
			aria-label={info.manifest.name}
			tabIndex={-1}
			onPointerDownCapture={() => {
				f.raise(id);
				f.setFocus(id);
			}}
			onFocusCapture={() => f.focus !== id && (f.raise(id), f.setFocus(id))}
			onKeyDownCapture={(e) => {
				if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
				// Esc in a field with text clears it first (the composer does that); otherwise it minimizes.
				const t = e.target as HTMLElement;
				if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value) return;
				if (t.closest("[role=menu], [role=listbox]")) return;
				e.preventDefault();
				e.stopPropagation();
				f.minimize(id);
			}}
			style={{ left: frame.x, bottom: frame.bottom, width: frame.w, height: mode === "bar" ? undefined : frame.h, zIndex: z }}
			className={cn(
				"pointer-events-auto fixed flex flex-col overflow-hidden border bg-popover text-popover-foreground outline-none transition-[box-shadow,border-color] duration-200",
				mode === "bar" ? "rounded-2xl" : "rounded-xl",
				front ? "shadow-[0_24px_60px_-14px_rgb(0_0_0/0.42)]" : "shadow-[0_10px_30px_-10px_rgb(0_0_0/0.28)]",
				focused && "border-ring/70",
				live && "select-none",
			)}
		>
			<FloatingContextValue info={info}>
				{!node ? (
					<div className="flex h-14 items-center gap-2 px-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{info.state === "running" ? "Loading…" : `${info.manifest.name} is ${info.state}`}</div>
				) : mode === "bar" ? (
					<AskBar info={info} node={node} emit={emit} focused={focused} onDrag={(e) => startDrag(e, "move")} onMinimize={() => f.minimize(id)} />
				) : (
					<>
						<TitleBar info={info} node={node} emit={emit} focused={focused} onDrag={(e) => startDrag(e, "move")} onMinimize={() => f.minimize(id)} />
						<PanelBody node={node} emit={emit} />
					</>
				)}
			</FloatingContextValue>
			{(mode === "bar" ? ["e", "w"] : ["n", "s", "e", "w", "ne", "nw", "se", "sw"]).map((edge) => (
				<div key={edge} aria-hidden="true" onPointerDown={(e) => startDrag(e, edge)} className={cn("absolute z-10", EDGE[edge])} />
			))}
		</section>
	);
}

const EDGE: Record<string, string> = {
	n: "inset-x-2 -top-1 h-2 cursor-ns-resize",
	s: "inset-x-2 -bottom-1 h-2 cursor-ns-resize",
	e: "inset-y-2 -right-1 w-2 cursor-ew-resize",
	w: "inset-y-2 -left-1 w-2 cursor-ew-resize",
	ne: "-top-1 -right-1 size-3 cursor-nesw-resize",
	sw: "-bottom-1 -left-1 size-3 cursor-nesw-resize",
	nw: "-top-1 -left-1 size-3 cursor-nwse-resize",
	se: "-right-1 -bottom-1 size-3 cursor-nwse-resize",
};

function FloatingContextValue({ info, children }: { info: PluginInfo; children: ReactNode }) {
	return (
		<SurfaceContext.Provider value={`${info.manifest.id}/${SURFACE}`}>
			<FloatingSurface.Provider value={true}>{children}</FloatingSurface.Provider>
		</SurfaceContext.Provider>
	);
}

function TitleName({ info, dim }: { info: PluginInfo; dim: boolean }) {
	return (
		<>
			<span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity", dim && "opacity-60")}>
				<Icon name={info.manifest.icon} className="size-3.5" />
			</span>
			<span className={cn("truncate text-sm font-semibold transition-opacity", dim && "opacity-60")}>{info.manifest.name}</span>
		</>
	);
}

/** The panel's title bar: drags the window; the plugin's actions and the minimize button. */
function TitleBar({ info, node, emit, focused, onDrag, onMinimize, onSwitch, mobile }: { info: PluginInfo; node: FloatingNode; emit: (name: string, payload?: unknown) => void; focused: boolean; onDrag?: (e: React.PointerEvent) => void; onMinimize: () => void; onSwitch?: () => void; mobile?: boolean }) {
	return (
		<div onPointerDown={onDrag} data-sheet-handle={mobile || undefined} className={cn("flex shrink-0 items-center gap-2 border-b pr-1.5 pl-3 select-none", mobile ? "h-13" : "h-11 cursor-grab active:cursor-grabbing")}>
			{onSwitch ? (
				// On a phone with several floating plugins, the name switches between them.
				<button type="button" onClick={onSwitch} aria-label={`${info.manifest.name}: switch tool`} aria-haspopup="menu" className="-ml-1 flex min-w-0 items-center gap-2 rounded-lg py-1 pr-1.5 pl-1 active:bg-accent">
					<TitleName info={info} dim={false} />
					<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
				</button>
			) : (
				<TitleName info={info} dim={!focused && !mobile} />
			)}
			{node.subtitle && <span className="truncate text-xs text-muted-foreground">{node.subtitle}</span>}
			<div className="ml-auto flex shrink-0 items-center gap-1">
				{node.actions?.map((a) => (
					<ShortcutTooltip key={a.id} label={a.label}>
						<Button variant="ghost" size="icon-sm" aria-label={a.label} aria-pressed={a.checked} disabled={a.disabled} onClick={() => emit(a.id, payloadFor({ kind: "action", action: a.id }))} className={cn("text-muted-foreground", a.checked && "bg-accent text-foreground")}>
							<Icon name={a.icon ?? "circle"} />
						</Button>
					</ShortcutTooltip>
				))}
				<ShortcutTooltip label={mobile ? "Close" : "Minimize to the sidebar"} keys="esc">
					<Button variant="ghost" size="icon-sm" aria-label={mobile ? "Close" : "Minimize"} onClick={onMinimize} className="text-muted-foreground">
						{mobile ? <X /> : <Minus />}
					</Button>
				</ShortcutTooltip>
			</div>
		</div>
	);
}

const fills = (c: Node) => c.type === "conversation" || c.type === "log" || c.type === "terminal";

/** The panel's content. A conversation, log or terminal fills the space; otherwise the content
 *  scrolls, like a page. A trailing composer floats over the bottom, the content scrolling under
 *  it: its height is `--floating-composer-height`, which the content keeps clear at its end. */
function PanelBody({ node, emit }: { node: FloatingNode; emit: (name: string, payload?: unknown) => void }) {
	const last = node.children[node.children.length - 1];
	const composer = last?.type === "composer" ? last : null;
	const body = composer ? node.children.slice(0, -1) : node.children;
	const filled = body.some(fills);
	const panel = useRef<HTMLDivElement>(null);
	const tray = useRef<HTMLDivElement>(null);
	// Set on the element as it resizes (not React state): the conversation's end follows it.
	useLayoutEffect(() => {
		const el = tray.current;
		const host = panel.current;
		if (!el || !host) return;
		const set = () => host.style.setProperty("--floating-composer-height", `${el.offsetHeight}px`);
		set();
		if (typeof ResizeObserver === "undefined") return;
		const watch = new ResizeObserver(set);
		watch.observe(el);
		return () => watch.disconnect();
	}, [!!composer]);
	return (
		<div ref={panel} className="relative flex min-h-0 flex-1 flex-col">
			<div data-floating-body className={cn("flex min-h-0 flex-1 flex-col", filled ? "gap-2 px-2.5 pt-2.5" : "gap-5 overflow-y-auto overscroll-contain px-4 pt-4", !filled && (composer ? "pb-[calc(var(--floating-composer-height,0px)+0.5rem)]" : "pb-[calc(var(--floating-safe-bottom,0px)+1.25rem)]"), filled && !composer && "pb-[calc(var(--floating-safe-bottom,0px)+0.625rem)]")}>
				{body.map((c, i) => (
					<div key={i} className={cn("min-w-0", fills(c) ? "flex min-h-0 flex-1 flex-col" : "shrink-0")}>
						<Render node={c} emit={emit} />
					</div>
				))}
			</div>
			{composer && (
				// The fade lets what scrolls under the tray disappear into the window; it passes the
				// pointer through to the content, the tray takes it.
				<div ref={tray} className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-popover from-55% to-transparent px-2.5 pt-4 pb-[calc(var(--floating-safe-bottom,0px)+0.625rem)]">
					<div className="pointer-events-auto">
						<Render node={composer} emit={emit} />
					</div>
				</div>
			)}
		</div>
	);
}

type ComposerNode = Extract<Node, { type: "composer" }>;

/** The ask bar: the composer as one big input, suggestions above it while it's empty and focused. */
function AskBar({ info, node, emit, focused, onDrag, onMinimize, mobile }: { info: PluginInfo; node: FloatingNode; emit: (name: string, payload?: unknown) => void; focused: boolean; onDrag?: (e: React.PointerEvent) => void; onMinimize: () => void; mobile?: boolean }) {
	const composer = node.children.find((c): c is ComposerNode => c.type === "composer");
	const others = node.children.filter((c) => c !== composer);
	const [draft, setDraft] = useUIState(`composer:${composer?.id ?? ""}:`, "");
	const [pick, setPick] = useState(0);
	const suggestions: Suggestion[] = node.suggestions ?? [];
	const showSuggestions = (focused || mobile) && !draft && suggestions.length > 0;
	const keys = keysOf(info);
	const send = (text: string) => {
		if (!composer || !text.trim() || composer.action.disabled) return;
		emit(composer.action.id, payloadFor({ kind: "action", action: composer.action.id, composer: composer.id, text: text.trim() }));
		setDraft("");
	};
	return (
		<>
			{showSuggestions && (
				<div className="max-h-[50vh] overflow-y-auto overscroll-contain border-b p-2 pb-1 animate-in fade-in-0 duration-150" role="listbox" aria-label="Suggestions">
					{suggestions.map((s, i) => {
						const heading = s.group && s.group !== suggestions[i - 1]?.group ? s.group : null;
						return (
							<div key={s.id} role="presentation">
								{heading && <div className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase", i > 0 ? "pt-2.5" : "pt-1")}>{heading}</div>}
								<button
									type="button"
									role="option"
									aria-selected={i === pick}
									tabIndex={-1}
									onMouseEnter={() => setPick(i)}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => emit(s.id, payloadFor({ kind: "action", action: s.id }))}
									className={cn("flex w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm", mobile ? "py-2.5 active:bg-accent" : "py-1.5", i === pick && !mobile && "bg-accent")}
								>
									<Icon name={s.icon ?? "sparkles"} className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate">{s.label}</span>
									{i === pick && !mobile ? (
										<Kbd className="shrink-0">↵</Kbd>
									) : s.metaAt !== undefined ? (
										<When at={s.metaAt} className="shrink-0 text-xs text-muted-foreground tabular-nums" />
									) : s.meta ? (
										<span className="shrink-0 text-xs text-muted-foreground">{s.meta}</span>
									) : null}
								</button>
							</div>
						);
					})}
				</div>
			)}
			{others.length > 0 && (
				<div className="flex flex-col gap-1.5 border-b px-3 py-2 text-sm">
					{others.map((c, i) => (
						<Render key={i} node={c} emit={emit} />
					))}
				</div>
			)}
			<div onPointerDown={onDrag} className={cn("flex shrink-0 items-center gap-2", mobile ? "h-14 pr-2.5 pl-4" : "h-13 cursor-grab pr-2 pl-1.5 active:cursor-grabbing")}>
				{!mobile && <GripVertical className="size-3.5 text-muted-foreground/50" aria-hidden="true" />}
				<Icon name={composer?.action.icon ?? info.manifest.icon} className="size-4 shrink-0 text-violet-600 dark:text-violet-300" />
				{composer ? (
					<input
						data-floating-input
						value={draft}
						disabled={composer.action.disabled}
						aria-label={composer.action.label}
						placeholder={composer.placeholder ?? composer.action.label}
						autoComplete="off"
						enterKeyHint="send"
						onChange={(e) => (setDraft(e.target.value), setPick(0))}
						onKeyDown={(e) => {
							if (e.nativeEvent.isComposing) return;
							if (e.key === "Enter") {
								e.preventDefault();
								if (draft.trim()) send(draft);
								else if (showSuggestions) emit(suggestions[pick].id, payloadFor({ kind: "action", action: suggestions[pick].id }));
							} else if (showSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
								e.preventDefault();
								setPick((p) => (p + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
							} else if (e.key === "Escape" && draft) {
								e.preventDefault();
								e.stopPropagation();
								setDraft("");
							}
						}}
						className={cn("min-w-0 flex-1 cursor-text bg-transparent outline-none placeholder:text-muted-foreground disabled:opacity-60", mobile ? "text-base" : "text-[15px]")}
					/>
				) : (
					<span className="flex-1 truncate text-sm text-muted-foreground">{info.manifest.name}</span>
				)}
				{!mobile && <Kbd className="shrink-0">{focused ? "esc" : (keys ?? "esc")}</Kbd>}
				{/* A phone gets the panel composer's send button. */}
				{mobile && composer && (
					<Button size="icon-sm" aria-label={composer.action.label} disabled={!draft.trim() || composer.action.disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => send(draft)} className="shrink-0 rounded-full">
						<ArrowUp />
					</Button>
				)}
				{node.actions?.map((a) => (
					<ShortcutTooltip key={a.id} label={a.label}>
						<Button variant="ghost" size="icon-sm" aria-label={a.label} disabled={a.disabled} onClick={() => emit(a.id, payloadFor({ kind: "action", action: a.id }))} className="text-muted-foreground">
							<Icon name={a.icon ?? "circle"} />
						</Button>
					</ShortcutTooltip>
				))}
				{!mobile && (
					<ShortcutTooltip label="Minimize to the sidebar" keys="esc">
						<Button variant="ghost" size="icon-sm" aria-label="Minimize" onClick={onMinimize} className="text-muted-foreground">
							<Minus />
						</Button>
					</ShortcutTooltip>
				)}
			</div>
		</>
	);
}

// ── phone ────────────────────────────────────────────────────────────────
/** The phone sheet's two heights (iOS's medium and large detents): CSS lengths, given the height
 *  the keyboard leaves visible (px, or none while it's closed). */
const sheetHeights = (visible: number | null) => {
	const full = `calc(${visible !== null ? `${visible}px` : "100dvh"} - max(env(safe-area-inset-top), 0.75rem) - 0.5rem)`;
	return [`min(58dvh, ${full})`, full];
};

/** A CSS length in px, as the page lays it out now. */
function cssPx(length: string) {
	const probe = document.createElement("div");
	probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;width:0;height:${length}`;
	document.body.appendChild(probe);
	const px = probe.getBoundingClientRect().height;
	probe.remove();
	return px;
}

/** While the on-screen keyboard is open: how much of the layout viewport it covers at the bottom,
 *  and the height left visible above it (px). iOS and Android overlay the keyboard instead of
 *  resizing the page, so a sheet along the bottom moves up by `inset` to stay above it. */
function useKeyboardArea() {
	const [kb, setKb] = useState<{ inset: number; visible: number } | null>(null);
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const update = () => {
			const inset = keyboardInset(window.innerHeight, vv);
			const next = inset ? { inset, visible: Math.round(vv.height) } : null;
			setKb((k) => (k?.inset === next?.inset && k?.visible === next?.visible ? k : next));
		};
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	}, []);
	return kb;
}

/**
 * On a phone: a button that opens one floating plugin at a time in a bottom sheet. A panel has two
 * heights, 58% of the screen and full height: the grabber (tap, Enter or a drag) and
 * the header change them; dragging down from the smaller one, Esc and the close button minimize it.
 */
function FloatingSheet() {
	const f = useFloating()!;
	const id = f.sheet.id;
	const info = f.plugins.find((p) => p.manifest.id === id) ?? f.plugins[0];
	const [full, setFull] = useState(false);
	const [menu, setMenu] = useState(false);
	const tree = useSurface(info?.manifest.id ?? "", SURFACE);
	// An ask bar is as tall as it needs; a panel takes most of the screen.
	const bar = tree?.type === "floating" && tree.mode === "bar";
	const kb = useKeyboardArea();
	const heights = sheetHeights(kb?.visible ?? null);
	const minimize = () => info && f.minimize(info.manifest.id);
	const drag = useSheetDrag({ side: "bottom", onDismiss: minimize, detent: bar ? 0 : full ? 1 : 0, onDetent: (i) => setFull(i === 1), heights: bar ? undefined : () => heights.map(cssPx) });
	useEffect(() => {
		// Each opening starts at the smaller height, like iOS sheets.
		if (!f.sheet.open) (setMenu(false), setFull(false));
	}, [f.sheet.open]);
	if (!info) return null;
	return (
		<>
			{/* Every floating plugin stays subscribed, so their badges and busy state keep up. */}
			{f.plugins.map((p) => <SheetWatcher key={p.manifest.id} info={p} />)}
			{!f.sheet.open && (
				<button
					type="button"
					aria-label={`Open ${info.manifest.name}`}
					onClick={() => f.open(info.manifest.id)}
					className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-40 flex size-13 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-200 active:scale-95"
				>
					<Icon name={info.manifest.icon} className="size-5.5" />
					{f.unread[info.manifest.id] && <span className="absolute top-1 right-1 size-2.5 rounded-full bg-violet-500 ring-2 ring-background" />}
				</button>
			)}
			{f.sheet.open && full && !bar && <div className="fixed inset-0 z-40 bg-black/25 animate-in fade-in-0 duration-200" onClick={() => setFull(false)} />}
			{f.sheet.open && (
				<section
					ref={drag}
					data-floating-sheet={info.manifest.id}
					aria-label={info.manifest.name}
					onKeyDownCapture={(e) => {
						// As on the Mac: Esc minimizes, after a field with text has cleared it (the composer does that).
						if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
						const t = e.target as HTMLElement;
						if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value) return;
						if (t.closest("[role=menu], [role=listbox]")) return;
						e.preventDefault();
						e.stopPropagation();
						if (menu) return setMenu(false);
						minimize();
					}}
					style={{ bottom: kb?.inset ?? 0, "--sheet-h": heights[full ? 1 : 0], "--sheet-max": heights[1], "--floating-safe-bottom": kb ? "0px" : "env(safe-area-inset-bottom)" } as React.CSSProperties}
					className={cn("fixed inset-x-0 z-50 flex flex-col rounded-t-[22px] border-t bg-popover text-popover-foreground shadow-[0_-10px_40px_-10px_rgb(0_0_0/0.35)] transition-[height,bottom] duration-200 ease-out animate-in slide-in-from-bottom-8 fade-in-0", bar ? "max-h-(--sheet-max)" : "h-(--sheet-h)")}
				>
					<div data-sheet-handle className="flex shrink-0 justify-center pt-1">
						<button type="button" aria-label={full ? "Make smaller" : "Make larger"} aria-expanded={bar ? undefined : full} disabled={bar} onClick={() => setFull(!full)} className="flex h-5 w-16 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<span className="h-1.5 w-10 rounded-full bg-border" />
						</button>
					</div>
					<SheetContent info={info} onSwitch={f.plugins.length > 1 ? () => setMenu(!menu) : undefined} />
					{menu && (
						<div role="menu" data-sheet-no-drag className="absolute top-14 left-3 z-10 w-60 rounded-xl border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 duration-150">
							{f.plugins.map((p) => (
								<button key={p.manifest.id} role="menuitem" type="button" onClick={() => (setMenu(false), f.open(p.manifest.id))} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left text-[15px]", p.manifest.id === info.manifest.id && "bg-accent")}>
									<Icon name={p.manifest.icon} className="size-4.5" />
									{p.manifest.name}
								</button>
							))}
						</div>
					)}
				</section>
			)}
		</>
	);
}

function SheetWatcher({ info }: { info: PluginInfo }) {
	useFloatingTree(info);
	return null;
}

function SheetContent({ info, onSwitch }: { info: PluginInfo; onSwitch?: () => void }) {
	const f = useFloating()!;
	const { node, emit } = useFloatingTree(info);
	const close = () => f.minimize(info.manifest.id);
	return (
		<FloatingContextValue info={info}>
			{/* A panel keeps the safe area clear itself, so its content scrolls under the composer to the edge. */}
			<div className={cn("flex min-h-0 flex-1 flex-col", (!node || node.mode === "bar") && "pb-(--floating-safe-bottom)")}>
				{node && <TitleBar info={info} node={{ ...node, actions: node.mode === "bar" ? [] : node.actions }} emit={emit} focused onMinimize={close} onSwitch={onSwitch} mobile />}
				{!node ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground"><Sparkles className="size-5 animate-pulse" /></div>
				) : node.mode === "bar" ? (
					<div className="flex min-h-0 flex-1 flex-col justify-end">
						<AskBar info={info} node={node} emit={emit} focused onMinimize={close} mobile />
					</div>
				) : (
					<PanelBody node={node} emit={emit} />
				)}
			</div>
		</FloatingContextValue>
	);
}
