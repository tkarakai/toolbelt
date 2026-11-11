import { SharedSelectionProvider, readSharedSelection, refreshSharedSelection } from "./lib/shared-selection";
import { captureQuickViewExit, QuickViewClosing, quickViewOrigin, type QuickViewExit } from "./QuickViewTransition";
import { selectedPaneItem, paneBookmark, restorePaneFocus, type PaneBookmark } from "./lib/pane-navigation";
import { usePluginDrag } from "./lib/use-plugin-drag";
// The menu-bar tool list stays visible beside the selected plugin's quick view.
// ↑/↓ and plugin hotkeys select; Enter opens the window; Escape closes.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Power, Settings } from "lucide-react";
import { defaultScreen } from "../shared/protocol";
import { popoverLayout, type PopoverLayout } from "../shared/popover";
import { assignLetters } from "../shared/letters";
import type { PluginInfo } from "../shared/rpc";
import { Icon } from "@/lib/icon";
import { rpc, sendEvent, usePlugins, usePopoverHiding, usePopoverShown, useSettings, useSurface } from "@/lib/store";
import { SurfaceContext, isTyping, usePersisted } from "@/lib/uistate";
import { Dot } from "@/renderer/Render";
import { SafeRender as Render } from "@/renderer/SafeRender";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { KeyHint } from "@/components/key-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { QuitDialog, askQuit } from "./QuitDialog";
import { PopoverUpdateRow, useUpdateState } from "./Updates";

const native = (window as { __electrobunWebviewId?: number }).__electrobunWebviewId !== undefined && location.hash === "#popover";
const panelStyle = "flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border bg-popover/95 text-popover-foreground shadow-xl backdrop-blur-xl";

export default function Popover() {
    const plugins = usePlugins();
    const drag = usePluginDrag(plugins.map(p => p.manifest.id));
    const development = useUpdateState()?.channel === "dev";
    const [settings] = useSettings();
    const [selected, setSelected] = usePersisted<string | null>("toolbelt.popoverPlugin", null);
    const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
    const [controlFocused, setControlFocused] = useState(false);
    const [activePane, setActivePane] = useState<"menu" | "detail">("menu");
    const detailMemory = useRef(new Map<string, PaneBookmark>());
    const lastCollection = useRef(new Map<string, string>());
    const mouseNavigation = useRef(false);
    const pointer = useRef<{ x: number; y: number } | null>(null);
    const current = plugins.find(p => p.manifest.id === selected) ?? plugins[0];
    const active = current ? plugins.indexOf(current) : -1;
    const [shown, setShown] = useState({ n: 0, closing: false });
    const [revealReady, setRevealReady] = useState(false);
    const [exits, setExits] = useState<QuickViewExit[]>([]);
    const [placedPlugin, setPlacedPlugin] = useState<string | null>(null);
    const exitNow = useRef<() => void>(() => {});
    const pendingFocus = useRef(false);
    const entered = useRef("");
    const box = useRef<HTMLDivElement>(null);
    const menu = useRef<HTMLElement>(null);
    const detail = useRef<HTMLElement>(null);
    const [layout, setLayout] = useState<PopoverLayout>({ x: 0, y: 0, width: 754, height: 520, menuWidth: 380, menuHeight: 520, detailWidth: 380, detailTop: 0, detailHeight: 520, overlap: 6, side: "left" });
    usePopoverShown(useCallback(() => {
        refreshSharedSelection();
        setActivePane("menu");
        mouseNavigation.current = false;
        setRevealReady(false);
        setExits([]);
        setPlacedPlugin(null);
        pendingFocus.current = false;
        entered.current = "";
        setShown(s => ({ n: s.n + 1, closing: false }));
        window.focus();
        menu.current?.focus({ preventScroll: true });
    }, []));
    usePopoverHiding(useCallback(() => {
        exitNow.current();
        pendingFocus.current = false;
        setShown(s => ({ ...s, closing: true }));
    }, []));
    // Hidden WKWebViews can advance animation clocks before the compositor presents
    // their first frame. Hold the initial pose until two visible animation frames.
    useLayoutEffect(() => {
        const element = box.current;
        if (!element || shown.closing) return;
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const animation = element.animate([
            { opacity: 0, transform: "scale(.95)" },
            { opacity: 1, transform: "scale(1)" },
        ], { duration: reduced ? 1 : 200, easing: "cubic-bezier(.16,1,.3,1)", fill: "both" });
        animation.pause();
        let second = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const first = requestAnimationFrame(() => {
            second = requestAnimationFrame(() => {
                animation.play();
                timer = setTimeout(() => setRevealReady(true), 200);
            });
        });
        return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); clearTimeout(timer); animation.cancel(); };
    }, [shown.n, shown.closing]);
    const letters = useMemo(() => assignLetters(plugins.map(p => ({ id: p.manifest.id, name: p.manifest.name }))), [plugins]);
    const hasDetails = !!current?.manifest.quickView;
    const showDetails = hasDetails && revealReady && !shown.closing;
    // Reserve the submenu geometry before first paint; the delayed reveal only
    // adds the panel, without resizing or moving the already-visible menu.
    const needsPanelSpace = (hasDetails && !shown.closing) || exits.length > 0;
    const reserveHeight = Math.max(0, ...exits.map(exit => exit.layout.height));
    const panelVisible = showDetails && placedPlugin === current?.manifest.id && layout.detailWidth > 0;
    exitNow.current = () => {
        if (!detail.current) return;
        const snapshot = captureQuickViewExit(detail.current, layout);
        setExits(previous => [...previous.slice(-1), snapshot]);
    };
    useLayoutEffect(() => {
        const el = menu.current;
        if (!el) return;
        let live = true;
        let last = "";
        const report = () => {
            const list = el.querySelector<HTMLElement>("[data-plugin-list]");
            // Measure the list's natural capped height even while the native window is
            // still compact from an empty list or a plugin without a quick view.
            const extra = list ? Math.max(0, Math.min(list.scrollHeight, parseFloat(getComputedStyle(list).maxHeight)) - list.clientHeight) : 0;
            const height = el.scrollHeight + extra + 2;
            const width = box.current?.parentElement?.clientWidth || window.innerWidth;
            const availableHeight = box.current?.closest(".tester-surface")?.clientHeight || window.innerHeight;
            const row = el.querySelector<HTMLElement>(`[data-index="${active}"]`);
            const scale = el.offsetHeight ? el.getBoundingClientRect().height / el.offsetHeight : 1;
            const anchorTop = row ? Math.round((row.getBoundingClientRect().top - el.getBoundingClientRect().top) / (scale || 1)) : 0;
            if (el.querySelector("[data-plugin-dragging]")) return;
            const signature = `${height}:${width}:${availableHeight}:${anchorTop}`;
            if (signature === last) return;
            last = signature;
            if (native) {
                void rpc.request.popoverLayout({ height, details: needsPanelSpace, anchorTop, reserveHeight }).then(next => {
                    if (live) { setLayout(next); setPlacedPlugin(current?.manifest.id ?? null); }
                });
            } else {
                setLayout(popoverLayout({ x: 0, y: 0, width: 0, height: 0 }, {
                    bounds: { height: availableHeight }, workArea: { x: 0, y: 0, width, height: availableHeight },
                }, height, needsPanelSpace, anchorTop, reserveHeight));
                setPlacedPlugin(current?.manifest.id ?? null);
            }
        };
        report();
        let frame = 0;
        const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(report); };
        el.addEventListener("scroll", schedule, true);
        const observer = new ResizeObserver(report);
        observer.observe(el);
        if (box.current?.parentElement) observer.observe(box.current.parentElement);
        window.addEventListener("resize", report);
        return () => { live = false; cancelAnimationFrame(frame); el.removeEventListener("scroll", schedule, true); observer.disconnect(); window.removeEventListener("resize", report); };
    }, [needsPanelSpace, reserveHeight, shown.n, active, current?.manifest.id]);
    useLayoutEffect(() => { menu.current?.focus({ preventScroll: true }); }, [shown.n]);
    useEffect(() => {
        menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active]);
    useEffect(() => {
        if (current && selected !== current.manifest.id) setSelected(current.manifest.id);
        if (!hasDetails) {
            setActivePane("menu");
            if (activePane === "detail") menu.current?.focus({ preventScroll: true });
        }
    }, [current?.manifest.id, hasDetails, selected, setSelected, activePane]);
    const focusDetails = useCallback(() => {
        if (!current?.manifest.quickView) return;
        if (!detail.current) { pendingFocus.current = true; return; }
        setActivePane("detail");
        if (detail.current.querySelector("[data-quick-content][aria-busy=true]")) detail.current.focus({ preventScroll: true });
        else restorePaneFocus(detail.current, detailMemory.current.get(current.manifest.id));
    }, [current?.manifest.id]);
    useEffect(() => {
        const pane = detail.current;
        if (!pane || activePane !== "detail") return;
        // A selected plugin may still be loading its first tree when the user enters it.
        const observer = new MutationObserver(() => {
            if (document.activeElement === pane || document.activeElement === document.body) focusDetails();
        });
        observer.observe(pane, { childList: true, subtree: true });
        if (document.activeElement === pane || document.activeElement === document.body) focusDetails();
        return () => observer.disconnect();
    }, [activePane, current?.manifest.id, focusDetails]);
    useLayoutEffect(() => {
        const pane = detail.current;
        if (!pane || !panelVisible) return;
        const row = menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
        const top = row && menu.current ? row.offsetTop - (menu.current.querySelector<HTMLElement>("[data-plugin-list]")?.scrollTop ?? 0) : layout.detailTop;
        pane.style.transformOrigin = quickViewOrigin(layout.side, top + (row?.offsetHeight ?? 52) / 2, layout.detailTop, layout.detailHeight);
        const key = `${shown.n}:${current?.manifest.id}`;
        if (entered.current !== key) {
            entered.current = key;
            const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
            const towardItem = layout.side === "left" ? 12 : -12;
            const animation = pane.animate([
                { opacity: 0, transform: `translateX(${towardItem}px)`, offset: 0 },
                { opacity: 1, transform: `translateX(${-Math.sign(towardItem)}px)`, offset: .8 },
                { opacity: 1, transform: "translateX(0)", offset: 1 },
            ], { duration: reduced ? 1 : 200, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" });
            animation.pause();
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (pane.isConnected) animation.play();
                else animation.cancel();
            }));
        }
        if (pendingFocus.current) { pendingFocus.current = false; focusDetails(); }
    }, [panelVisible, current?.manifest.id, shown.n, layout, active, focusDetails]);
    const select = (index: number) => {
        if (plugins[index]?.manifest.id !== current?.manifest.id) exitNow.current();
        pendingFocus.current = false;
        setSelected(plugins[index]?.manifest.id ?? null);
        setActivePane("menu");
        menu.current?.focus({ preventScroll: true });
    };
    const pick = useCallback((plugin: PluginInfo) => rpc.send.showWindow({ plugin: plugin.manifest.id, screen: defaultScreen(plugin.manifest),
        selection: readSharedSelection(plugin.manifest.id) ?? undefined }), []);
    const openQuick = useCallback(() => {
        if (current) rpc.send.showWindow({ plugin: current.manifest.id, screen: defaultScreen(current.manifest),
            selection: selectedPaneItem(detail.current, lastCollection.current.get(current.manifest.id)) ?? readSharedSelection(current.manifest.id) ?? undefined });
    }, [current]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
            const inDetails = detail.current?.contains(event.target as Node);
            const consume = () => { mouseNavigation.current = false; event.preventDefault(); event.stopImmediatePropagation(); };
            if (menu.current?.querySelector("[data-plugin-dragging]")) {
                // Let the drag handler cancel on Escape before the popover can close.
                if (event.key !== "Escape") consume();
                return;
            }
            mouseNavigation.current = false;
            if (box.current) box.current.dataset.pointerNavigation = "false";
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) { consume(); return; }
            if (isTyping(event)) return;
            const towardDetails = layout.side === "left" ? "ArrowLeft" : "ArrowRight";
            const towardMenu = layout.side === "left" ? "ArrowRight" : "ArrowLeft";
            if (event.key === "Escape") {
                consume();
                if (inDetails || activePane === "detail") { setActivePane("menu"); menu.current?.focus({ preventScroll: true }); }
                else rpc.send.hidePopover({});
                return;
            }
            if (inDetails || activePane === "detail") {
                if (event.key === towardMenu) { consume(); setActivePane("menu"); menu.current?.focus({ preventScroll: true }); }
                else if (event.key === "Enter" && current && !(event.target as HTMLElement).closest("button, a, [role=switch], [role=checkbox]")) {
                    consume();
                    openQuick();
                }
                return;
            }
            if (event.key === "Tab") return;
            const controls = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[data-update-notice], [data-plugin-sort], [data-footer-control]") ?? []);
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const from = controls.indexOf(event.target as HTMLButtonElement);
                const index = from >= 0 ? from : controls.findIndex(button => button.dataset.pluginSort === current?.manifest.id);
                const next = controls[index + (event.key === "ArrowDown" ? 1 : -1)];
                if (next) { consume(); next.focus({ preventScroll: true }); return; }
            }
            if ((event.target as HTMLElement).closest("button:not([data-plugin-sort])")) return;
            if (event.key === towardDetails) { consume(); focusDetails(); return; }
            if (event.key === towardMenu) { consume(); return; }
            // Footer controls retain their normal Enter/Space behavior.
            if ((event.target as HTMLElement).closest("button") && !(event.target as HTMLElement).closest("[data-plugin-sort]")) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                consume(); select(Math.max(0, Math.min(plugins.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
            } else if (event.key === "Enter" && current) { consume(); pick(current); }
            else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
                const byLetter = plugins.find(p => letters.get(p.manifest.id) === event.key.toLowerCase());
                const n = Number(event.key);
                if (byLetter) { consume(); select(plugins.indexOf(byLetter)); }
                else if (n >= 1 && n <= 9 && plugins[n - 1]) { consume(); select(n - 1); }
            }
        };
        // Capture before quick-view tables' global shortcuts so the main list owns its keys.
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [current, plugins, active, pick, letters, layout.side, activePane, focusDetails, openQuick]);
    const SideChevron = layout.side === "left" ? ChevronLeft : ChevronRight;
    return (
        <div key={shown.n} ref={box} data-pointer-navigation="false"
            onPointerDownCapture={() => {
                mouseNavigation.current = true;
                if (box.current) box.current.dataset.pointerNavigation = "true";
            }}
            onPointerMoveCapture={event => {
                const previous = pointer.current;
                if (!previous || previous.x !== event.clientX || previous.y !== event.clientY) {
                    mouseNavigation.current = true;
                    if (box.current) box.current.dataset.pointerNavigation = "true";
                }
                pointer.current = { x: event.clientX, y: event.clientY };
            }}
            style={{ width: layout.width, height: layout.height, maxWidth: "100%", marginLeft: layout.side === "left" ? "auto" : 0 }}
            className={cn("relative",
                shown.closing ? "animate-out fade-out-0 zoom-out-95 fill-mode-forwards duration-150" : "")}>
            <section ref={menu} tabIndex={-1} aria-label="Plugins" data-keyboard-pane="menu" data-keyboard-active={activePane === "menu"}
                onFocusCapture={event => { setActivePane("menu"); setControlFocused(!!(event.target as HTMLElement).closest("button:not([data-plugin-sort])")); }}
                style={{ minHeight: updatePanelOpen ? 300 : undefined, width: layout.menuWidth, maxHeight: layout.menuHeight, left: layout.side === "left" ? layout.width - layout.menuWidth : 0 }}
                className={cn(panelStyle, "absolute top-0 z-10 outline-none")}>
					<div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-2">
						<span className="text-sm font-semibold">{development ? "ToolBelt Dev" : "ToolBelt"}</span>
						{settings && <Kbd>{settings.shortcutLabel}</Kbd>}
                        <PopoverUpdateRow onPanelChange={setUpdatePanelOpen} />
					</div>
					{/* Six rows, then it scrolls (without a scroll bar). */}
					<div {...drag} data-plugin-list className="no-scrollbar max-h-[calc(6*3.25rem+0.5rem)] min-h-0 overflow-auto px-2 pb-2">
						{plugins.map((p, i) => (
							<button
								key={p.manifest.id}
								data-plugin-sort={p.manifest.id}
                                style={{ touchAction: "none", userSelect: "none" }}
                                data-index={i}
								data-active={i === active && !controlFocused}
								onMouseEnter={() => { if (mouseNavigation.current) select(i); }}
                                onMouseMove={() => { if (mouseNavigation.current && (activePane !== "menu" || selected !== p.manifest.id)) select(i); }}
                                tabIndex={i === active ? 0 : -1}
                                aria-current={i === active && !controlFocused ? "true" : undefined}
                                onFocus={() => { if (selected !== p.manifest.id) select(i); }}
								onClick={() => pick(p)}
								className="group flex h-13 w-full items-center gap-3 rounded-lg px-2.5 text-left outline-none data-[active=true]:bg-selected data-[active=true]:text-selected-foreground"
							>
								<div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-foreground">
									<Icon name={p.manifest.icon} className="size-4" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2 text-sm font-medium">
										<span className="truncate">{p.manifest.name}</span>
										{p.state !== "running" && <Dot tone={p.state === "crashed" ? "danger" : "warning"} />}
									</div>
									<div className="truncate text-xs text-muted-foreground">{p.manifest.description}</div>
								</div>
								{p.badge !== null && (
									<Badge variant="secondary" className="tabular-nums">
										{p.badge}
									</Badge>
								)}
								{letters.has(p.manifest.id) && (
									<Kbd className="uppercase group-data-[active=true]:bg-selected-foreground/15 group-data-[active=true]:text-selected-foreground" title={`${letters.get(p.manifest.id)!.toUpperCase()} selects ${p.manifest.name}`}>
										{letters.get(p.manifest.id)}
									</Kbd>
								)}
								{p.manifest.quickView && <SideChevron className={cn("size-4 text-muted-foreground/50", i === active && "text-selected-foreground")} />}
							</button>
						))}
					</div>
					<div className="flex shrink-0 flex-wrap items-center gap-1 border-t px-2 py-1.5">
						<Button data-footer-control variant="ghost" size="sm" title="Settings" aria-label="Settings" onClick={() => rpc.send.showWindow({ plugin: "toolbelt" })}><Settings /><KeyHint keys="⌘," /></Button>
                        <Button data-footer-control variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={askQuit}>
							<Power />
							Quit
							<KeyHint keys="⌘Q" />
						</Button>
					</div>
            </section>
            {panelVisible && current && <aside key={current.manifest.id} ref={detail} tabIndex={-1} aria-label={`${current.manifest.name} quick view`}
                data-keyboard-pane="detail" data-keyboard-active={activePane === "detail"}
                onMouseEnter={() => { if (mouseNavigation.current && activePane !== "detail") focusDetails(); }}
                onMouseMove={() => { if (mouseNavigation.current && activePane !== "detail") focusDetails(); }}
                onPointerDownCapture={() => setActivePane("detail")}
                onFocusCapture={event => {
                    setActivePane("detail");
                    if (event.target !== detail.current && detail.current) {
                        const bookmark = paneBookmark(detail.current, event.target as HTMLElement);
                        detailMemory.current.set(current.manifest.id, bookmark);
                        if (bookmark.collection) lastCollection.current.set(current.manifest.id, bookmark.collection);
                    }
                }}
                style={{ width: layout.detailWidth, height: layout.detailHeight, top: layout.detailTop, left: layout.side === "left" ? 0 : layout.menuWidth - layout.overlap }}
                className={cn(panelStyle, "absolute z-20 outline-none transition-[top,left,width,height] duration-200 ease-out motion-reduce:transition-none")}>
                <div key={current.manifest.id} className="flex min-h-0 flex-1 flex-col">
                    <PluginDetails info={current} onOpen={openQuick} />
                </div>
            </aside>}
            {exits.map(snapshot => <QuickViewClosing key={snapshot.id} snapshot={snapshot}
                onDone={id => setExits(previous => previous.filter(exit => exit.id !== id))} />)}
            <QuitDialog />
        </div>
    );
}

function PluginDetails({ info, onOpen }: { info: PluginInfo; onOpen: () => void }) {
    const m = info.manifest;
    return <>
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2">
            <Icon name={m.icon} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{m.name}</span>
            <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground"
                onClick={onOpen} title="Open in the ToolBelt window">
                <Maximize2 /> Open
            </Button>
        </div>
        <QuickContent key={m.id} info={info} />
    </>;
}

function QuickContent({ info }: { info: PluginInfo }) {
    const id = info.manifest.id;
    const tree = useSurface(id, "quick");
    const emit = useCallback((name: string, payload?: unknown) => sendEvent(id, "quick", name, payload), [id]);
    return <div data-quick-content aria-busy={!tree} className="min-h-0 flex-1 overflow-auto p-2">
        {tree ? <SurfaceContext.Provider value={`${id}/quick`}><SharedSelectionProvider plugin={id} tree={tree}><Render node={tree} emit={emit} /></SharedSelectionProvider></SurfaceContext.Provider> :
            <div className="space-y-2 p-1">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
    </div>;
}
