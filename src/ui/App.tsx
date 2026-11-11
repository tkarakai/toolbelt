import { SharedSelectionProvider, writeSharedSelection } from "./lib/shared-selection";
import { findSelectionTarget, settingsReturnHash, type NavigationSelection } from "../shared/navigation";
import { SelectionHandoffContext, SelectionRequestContext } from "./lib/selection-handoff";
import { usePluginDrag } from "./lib/use-plugin-drag";
import { PluginManager } from "./PluginManager";
// The main window: the app sidebar (resizable, collapses to an icon rail) and the selected
// plugin's pane with its tabs. Route: #/<plugin>/<screen>, or #/toolbelt for ToolBelt's own page.
//
// Keyboard: ⌘1…9 tools (hold ⌘ to see the numbers) · manifest-declared tab shortcuts · ⌃⇥ / ⌃⇧⇥ next and
// previous tab · ⌘B sidebar · ⌘W closes the window (app menu).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, Check, PanelLeft, RotateCw, Settings, X } from "lucide-react";
import { defaultScreen, type Manifest } from "../shared/protocol";
import type { PluginInfo } from "../shared/rpc";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { committed, rpc, sendEvent, useCommand, useNavigate, usePlugins, useSettings, useSurface } from "@/lib/store";
import { THEMES, tokens } from "./themes";
import { QuitDialog } from "./QuitDialog";
import { SurfaceContext, isTyping, useHeldModifiers, usePersisted } from "@/lib/uistate";
import { WindowZoom, ZoomKeys } from "@/lib/zoom";
import { UpdateIndicator, UpdatesCard, useAnyUpdateAvailable, usePluginUpdateAvailable, useUpdateAvailable, useUpdateState } from "./Updates";
import { EmptyState, Dot } from "@/renderer/Render";
import { SafeRender as Render } from "@/renderer/SafeRender";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { KeyHint } from "@/components/key-hint";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsGroup, SettingsRow } from "./components/settings-layout";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	useSidebar,
} from "@/components/ui/sidebar";

const TOOLBELT = "toolbelt";
/** Where the traffic lights end, plus breathing room (window x, px). With the window's
 *  `trafficLightOffset` of 6 they sit at x 15…69, y 15…29 (measured via the debug channel). */
const TRAFFIC_LIGHTS_END = 80;
const RAIL = 48; // --sidebar-width-icon
const inApp = (window as { __electrobunWebviewId?: number }).__electrobunWebviewId !== undefined;
/** The active sidebar item uses the selection colors. */
const ACTIVE = "data-[active=true]:bg-selected data-[active=true]:text-selected-foreground data-[active=true]:hover:bg-selected data-[active=true]:hover:text-selected-foreground";

/** Double-clicking empty title-bar space zooms the window, like a native title bar. */
function zoomOnDoubleClick(e: React.MouseEvent) {
	if ((e.target as HTMLElement).closest("button, [role=tab], [role=tablist], input, a")) return;
	rpc.send.zoomWindow({});
}

/** App-menu commands for the sidebar (⌘B is a menu item, so the web view never sees it). */
function SidebarCommands() {
	const { toggleSidebar } = useSidebar();
	useCommand(useCallback((name: string) => name === "toggleSidebar" && toggleSidebar(), [toggleSidebar]));
	return null;
}

function parseHash(): { plugin?: string; screen?: string } {
	const [, plugin, screen] = location.hash.replace(/^#/, "").split("/");
	return { plugin: plugin || undefined, screen: screen || undefined };
}

export default function App() {
	const plugins = usePlugins();
	const [route, setRoute] = useState(parseHash);
	// Each tool's last tab, remembered across window closes and restarts.
	const [lastScreens, setLastScreens] = usePersisted<Record<string, string>>("toolbelt.screens", {});
	const lastScreen = useRef<Record<string, string>>(lastScreens);
	const [lastPlugin, setLastPlugin] = usePersisted<string | null>("toolbelt.plugin", null);
	// Where ToolBelt's own page goes back to (esc, its close button).
	const before = useRef<string>("");
    const [handoff, setHandoff] = useState<{ plugin: string; selection: NavigationSelection; token: number } | null>(null);

	useEffect(() => {
		const on = () => setRoute(parseHash());
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	const go = useCallback((plugin: string, screen?: string) => {
        setHandoff(null);
		if (plugin === TOOLBELT && parseHash().plugin !== TOOLBELT) before.current = location.hash;
		location.hash = `#/${plugin}${screen ? `/${screen}` : ""}`;
	}, []);
	const back = useCallback(() => {
        location.hash = settingsReturnHash(before.current, lastPlugin, plugins.map(p => p.manifest.id));
    }, [plugins, lastPlugin]);
    const navigationToken = useRef(0);
    useNavigate(useCallback((plugin: string, screen?: string, selection?: NavigationSelection) => {
        if (selection) writeSharedSelection(plugin, selection);
        go(plugin, screen);
        if (plugin === TOOLBELT && screen === "updates") requestAnimationFrame(() => document.getElementById("updates")?.scrollIntoView({ block: "start" }));
        setHandoff(selection ? { plugin, selection, token: ++navigationToken.current } : null);
    }, [go]));

	// Default route: the remembered plugin, else the first.
	const pluginId = route.plugin ?? (plugins.some(p => p.manifest.id === lastPlugin) ? lastPlugin ?? undefined : plugins[0]?.manifest.id);
	useEffect(() => {
		if (pluginId && pluginId !== TOOLBELT) setLastPlugin(pluginId);
	}, [pluginId, setLastPlugin]);
	const current = plugins.find((p) => p.manifest.id === pluginId);
	const screen = current ? (route.screen ?? lastScreen.current[current.manifest.id] ?? defaultScreen(current.manifest)) : undefined;
	useEffect(() => {
		if (!current || !screen || lastScreen.current[current.manifest.id] === screen) return;
		lastScreen.current = { ...lastScreen.current, [current.manifest.id]: screen };
		setLastScreens(lastScreen.current);
	}, [current, screen, setLastScreens]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;
            if (e.key === "F6" && current) {
                e.preventDefault();
                const tabs = document.querySelector('[role="tablist"]');
                const pane = document.querySelector<HTMLElement>('[data-plugin-pane]');
                if (pane?.contains(document.activeElement)) tabs?.querySelector<HTMLElement>('[data-state="active"]')?.focus();
                else pane?.focus();
                return;
            }
			const n = Number(e.key) || Number(e.code.replace("Digit", ""));
			const screens = current?.manifest.screens ?? [];
            const tab = e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey ? screens.find(s => s.shortcut === e.key.toLowerCase()) : undefined;
            if (tab && current) { e.preventDefault(); go(current.manifest.id, tab.id); return; }
			if (e.metaKey && !e.altKey && !e.ctrlKey && n >= 1 && n <= 9) {
				const p = plugins[n - 1];
				if (p) (e.preventDefault(), go(p.manifest.id));
			} else if (e.metaKey && e.altKey && n >= 1 && n <= 9 && current) {
				const s = screens[n - 1];
				if (s) (e.preventDefault(), go(current.manifest.id, s.id));
			} else if (e.ctrlKey && e.key === "Tab" && current && screen && screens.length > 1) {
				e.preventDefault();
				const i = screens.findIndex((s) => s.id === screen);
				go(current.manifest.id, screens[(i + (e.shiftKey ? -1 : 1) + screens.length) % screens.length].id);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [current, screen, plugins, go]);

	const [width, setWidth] = usePersisted("toolbelt.sidebarWidth", 240);
	const [open, setOpen] = usePersisted("toolbelt.sidebarOpen", true);

	return (
		<SidebarProvider open={open} onOpenChange={setOpen} style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
			{!inApp && <FakeTrafficLights />}
			<QuitDialog />
			<ZoomKeys />
			<WindowZoom />
			<AppSidebar plugins={plugins} current={route.plugin === TOOLBELT ? TOOLBELT : pluginId} go={go} onResize={setWidth} />
			<SidebarInset className="min-w-0" onPointerDownCapture={() => setHandoff(null)} onKeyDownCapture={() => setHandoff(null)}>
				{route.plugin === TOOLBELT ? (
					<ToolbeltPage plugins={plugins} onClose={back} section={route.screen} />
				) : current && screen ? (
					<PluginPane key={current.manifest.id} info={current} screen={screen} go={go} handoff={handoff?.plugin === current.manifest.id ? handoff : null} onHandoffApplied={() => setHandoff(null)} />
				) : plugins.length ? null : (
					<div className="p-8"><h1 className="text-lg font-medium">Welcome to ToolBelt</h1><p className="my-3 text-muted-foreground">Install a plugin to get started.</p><Button onClick={()=>go(TOOLBELT)}>Manage plugins</Button></div>
				)}
			</SidebarInset>
		</SidebarProvider>
	);
}

/** In the browser preview, stand-ins for the window buttons, to judge the layout around them. */
function FakeTrafficLights() {
	return (
		<div className="pointer-events-none fixed top-[15px] left-[15px] z-50 flex gap-1.5">
			{["#ff5f57", "#febc2e", "#28c840"].map((c) => (
				<span key={c} className="size-3.5 rounded-full" style={{ background: c }} />
			))}
		</div>
	);
}

// ── sidebar ──────────────────────────────────────────────────────────────
function AppSidebar({ plugins, current, go, onResize }: { plugins: PluginInfo[]; current?: string; go: (p: string, s?: string) => void; onResize: (w: number) => void }) {
	const { state, setOpen } = useSidebar();
	const hints = useHeldModifiers({ meta: true });
	const update = useAnyUpdateAvailable();
	const drag = usePluginDrag(plugins.map(p => p.manifest.id));
	return (
		<Sidebar collapsible="icon" className="group-data-[side=left]:border-r-0">
			<SidebarCommands />
			{/* Room for the traffic lights; the strip drags the window. Collapsed, it joins the pane
			    header so the buttons sit on one continuous bar. */}
			<SidebarHeader onDoubleClick={zoomOnDoubleClick} className="electrobun-webkit-app-region-drag h-12 shrink-0 flex-row items-center justify-end px-3 group-data-[collapsible=icon]:border-b group-data-[collapsible=icon]:bg-background">
				{state === "expanded" && <CollapseButton />}
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Tools</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu {...drag}>
							{plugins.map((p, i) => (
								<SidebarMenuItem key={p.manifest.id} data-plugin-sort={p.manifest.id} style={{ touchAction: "none", userSelect: "none" }}>
									<SidebarMenuButton isActive={current === p.manifest.id} tooltip={`${p.manifest.name}  ⌘${i + 1}`} onClick={() => go(p.manifest.id)} className={cn("h-9", ACTIVE)}>
										<Icon name={p.manifest.icon} />
										<span className="truncate">{p.manifest.name}</span>
										{p.state !== "running" && <Dot tone={p.state === "crashed" ? "danger" : "warning"} className="ml-auto group-data-[collapsible=icon]:hidden" />}
									</SidebarMenuButton>
									{hints && i < 9 ? (
										<>
											<SidebarMenuBadge className="group-has-[[data-active=true]]/menu-item:text-selected-foreground">
												<Kbd>⌘{i + 1}</Kbd>
											</SidebarMenuBadge>
											<Kbd className="pointer-events-none absolute -top-1 -right-1 hidden h-4 min-w-4 px-1 text-[10px] group-data-[collapsible=icon]:inline-flex">{i + 1}</Kbd>
										</>
									) : (
										p.badge !== null && p.badge !== undefined && <SidebarMenuBadge className="tabular-nums group-has-[[data-active=true]]/menu-item:text-selected-foreground">{p.badge}</SidebarMenuBadge>
									)}
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						{/* ToolBelt's settings: just the cog and its shortcut. */}
						<SidebarMenuButton isActive={current === TOOLBELT} tooltip="Settings" title="Settings" aria-label="ToolBelt settings" onClick={() => go(TOOLBELT)} className={cn("relative w-full", ACTIVE)}>
							<span className="relative inline-flex size-4 shrink-0"><Settings className="size-4"/>{update && <UpdateIndicator className="absolute -right-1 -top-1" />}</span>
							<KeyHint keys="⌘," className="group-data-[collapsible=icon]:hidden" />
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<ResizeHandle onResize={onResize} onCollapse={() => setOpen(false)} onExpand={() => setOpen(true)} collapsed={state === "collapsed"} />
		</Sidebar>
	);
}

function CollapseButton() {
	const { toggleSidebar, state } = useSidebar();
	return (
		<Button variant="ghost" size="sm" className="electrobun-webkit-app-region-no-drag gap-1 px-1.5 text-muted-foreground" onClick={toggleSidebar} aria-label={state === "expanded" ? "Collapse sidebar (⌘B)" : "Expand sidebar (⌘B)"} title={state === "expanded" ? "Collapse sidebar  ⌘B" : "Expand sidebar  ⌘B"}>
			<PanelLeft />
			<KeyHint keys="⌘B" />
		</Button>
	);
}

/** Drag the sidebar's edge to resize it; drag it far enough left and it collapses to icons. */
function ResizeHandle({ onResize, onCollapse, onExpand, collapsed }: { onResize: (w: number) => void; onCollapse: () => void; onExpand: () => void; collapsed: boolean }) {
	const onPointerDown = (e: React.PointerEvent) => {
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		document.body.style.cursor = "col-resize";
		const move = (ev: PointerEvent) => {
			const x = ev.clientX;
			if (x < 120) onCollapse();
			else {
				if (collapsed) onExpand();
				onResize(Math.max(200, Math.min(400, x)));
			}
		};
		const up = () => {
			document.body.style.cursor = "";
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	};
	return (
		<div
			onPointerDown={onPointerDown}
			onDoubleClick={() => (collapsed ? onExpand() : onCollapse())}
			className={cn("absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-border after:transition-colors hover:after:bg-ring/60", collapsed && "top-12")}
		/>
	);
}

// ── plugin pane ──────────────────────────────────────────────────────────
/** The pane's top bar. The whole bar drags the window, except its controls. */
function PaneHeader({ manifest, children }: { manifest: Pick<Manifest, "name" | "icon">; children?: ReactNode }) {
	const { state } = useSidebar();
	const collapsed = state === "collapsed";
	return (
		<header onDoubleClick={zoomOnDoubleClick} className="electrobun-webkit-app-region-drag flex h-12 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-b pr-6" style={{ paddingLeft: collapsed ? TRAFFIC_LIGHTS_END - RAIL : 24 }}>
			{collapsed && (
				<div className="-ml-1">
					<CollapseButton />
				</div>
			)}
			<div className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-2.5">
				<div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
					<Icon name={manifest.icon} className="size-4" />
				</div>
				<h1 className="truncate text-sm font-semibold">{manifest.name}</h1>
			</div>
			{children}
		</header>
	);
}

function PluginPane({ info, screen, go, handoff, onHandoffApplied }: { info: PluginInfo; screen: string; go: (p: string, s?: string) => void; handoff: { selection: NavigationSelection; token: number } | null; onHandoffApplied: () => void }) {
	const m = info.manifest;
    const development = useUpdateState()?.channel === "dev";
	return (
		<div className="flex h-svh min-h-0 flex-col animate-in fade-in-0 duration-200">
			<PaneHeader manifest={m}>
                {development && <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">DEV</Badge>}
				{m.screens.length > 1 && (
					<Tabs value={screen} onValueChange={(s) => go(m.id, s)} className="electrobun-webkit-app-region-no-drag min-w-0 shrink overflow-hidden">
						<TabsList>
							{m.screens.map((s, i) => (
								<TabsTrigger key={s.id} value={s.id} className="flex-none gap-0 px-3 data-[state=active]:bg-selected! data-[state=active]:text-selected-foreground! data-[state=active]:hover:text-selected-foreground!" title={`${s.title}  ${s.shortcut ? `⌘${s.shortcut.toUpperCase()}` : `⌥⌘${i + 1}`}`}>
									<span className="inline-flex items-center gap-1.5">{s.icon && <Icon name={s.icon} />}{s.title}</span>
                                    <KeyHint className="ml-1.5 shrink-0" keys={s.shortcut ? `⌘${s.shortcut.toUpperCase()}` : `⌥⌘${i + 1}`} />
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
				)}
                <div data-window-drag-handle aria-hidden="true" className="electrobun-webkit-app-region-drag min-w-8 flex-1 self-stretch" />
				{info.state !== "running" && (
					<Badge variant={info.state === "crashed" ? "destructive" : "secondary"} className="electrobun-webkit-app-region-no-drag ml-auto">
						{info.state}
					</Badge>
				)}
			</PaneHeader>
			<div data-plugin-pane tabIndex={0} role="region" aria-label={`${m.name} content`} className="min-h-0 flex-1 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring">{info.state === "crashed" ? <Crashed info={info} /> : <Screen key={screen} plugin={m.id} surface={`screen:${screen}`} handoff={handoff} onHandoffApplied={onHandoffApplied} />}</div>
		</div>
	);
}

function Screen({ plugin, surface, handoff, onHandoffApplied }: { plugin: string; surface: string; handoff: { selection: NavigationSelection; token: number } | null; onHandoffApplied: () => void }) {
	const tree = useSurface(plugin, surface);
	const emit = useCallback((name: string, payload?: unknown) => sendEvent(plugin, surface, name, payload), [plugin, surface]);
	useLayoutEffect(() => committed(plugin, surface), [tree, plugin, surface]);
    const target = tree && handoff ? findSelectionTarget(tree, handoff.selection) : null;
	if (!tree) return <Loading />;
	return (
		<SurfaceContext.Provider value={`${plugin}/${surface}`}>
            <SelectionRequestContext.Provider value={handoff}>
            <SelectionHandoffContext.Provider value={target && handoff ? { ...target, token: handoff.token, onApplied: onHandoffApplied } : null}>
			<div className="h-full min-h-0 animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
                <SharedSelectionProvider plugin={plugin} tree={tree} seedLegacy><Render node={tree} emit={emit} /></SharedSelectionProvider>
			</div>
            </SelectionHandoffContext.Provider>
            </SelectionRequestContext.Provider>
		</SurfaceContext.Provider>
	);
}

function Crashed({ info }: { info: PluginInfo }) {
	return (
		<div className="mx-auto max-w-xl px-6 py-12">
			<EmptyState icon="bug" title={`${info.manifest.name} stopped working`} description="It crashed a few times in a row, so ToolBelt stopped restarting it." />
			{info.error && <pre className="mt-2 max-h-60 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{info.error}</pre>}
			<div className="mt-4 flex justify-center">
				<Button onClick={() => void rpc.request.restartPlugin({ plugin: info.manifest.id })}>
					<RotateCw />
					Restart
				</Button>
			</div>
		</div>
	);
}

function Loading() {
	return (
		<div className="space-y-3 p-6">
			<Skeleton className="h-8 w-72" />
			{Array.from({ length: 6 }, (_, i) => (
				<Skeleton key={i} className="h-11 w-full" />
			))}
		</div>
	);
}

// ── ToolBelt's own page ──────────────────────────────────────────────────
const SETTINGS_TABS = [
    {id: "appearance", label: "Appearance", shortcut: "a", icon: "palette"},
    {id: "plugins", label: "Plugins", shortcut: "p", icon: "puzzle"},
    {id: "keyboard", label: "Keyboard", shortcut: "k", icon: "keyboard"},
    {id: "about", label: "About", shortcut: "i", icon: "info"},
];
function ToolbeltPage({ onClose, section }: { plugins: PluginInfo[]; onClose: () => void; section?: string }) {
    const pluginUpdates = usePluginUpdateAvailable();
    const appUpdate = useUpdateAvailable();
    const [remembered, remember] = usePersisted<string>("toolbelt.settings-tab", "appearance");
    const fallback = SETTINGS_TABS.some(t => t.id === remembered) ? remembered : "appearance";
    const initialTab = section === "updates" ? "about" : section === "tools" ? "plugins" : section || fallback;
    const [tab, setTab] = useState(initialTab);
    useEffect(() => { if (!section) return; setTab(section === "updates" ? "about" : section === "tools" ? "plugins" : section || fallback); }, [section]);

    useEffect(() => { remember(tab); }, [tab]);
    useEffect(() => {
        const tabs = ["appearance", "plugins", "keyboard", "about"];
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
            const n = Number(e.code.replace("Digit", ""));
            let next: string | undefined;
            if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && !isTyping(e)) next = SETTINGS_TABS.find(t => t.shortcut === e.key.toLowerCase())?.id;
            if (e.metaKey && e.altKey && n >= 1 && n <= tabs.length) next = tabs[n - 1];
            else if (e.ctrlKey && e.key === "Tab") next = tabs[(tabs.indexOf(tab) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
            if (next) { e.preventDefault(); setTab(next); location.hash = `#/toolbelt/${next}`; }
            if (e.key === "F6") {
                e.preventDefault();
                const root = document.querySelector('[aria-label="Settings tabs"]');
                const content = document.querySelector<HTMLElement>('[aria-label="Settings content"]');
                if (content?.contains(document.activeElement)) root?.querySelector<HTMLElement>('[data-state="active"]')?.focus();
                else content?.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [tab]);
	// Esc goes back to where you were — unless something on the page wants it (a dialog, a field).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || isTyping(e) || document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
			e.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="flex h-svh min-h-0 flex-col animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
			<PaneHeader manifest={{ name: "Settings", icon: "settings" }}>
                <Tabs value={tab} onValueChange={next => { setTab(next); location.hash = `#/toolbelt/${next}`; }} className="electrobun-webkit-app-region-no-drag min-w-0 shrink overflow-hidden">
                    <TabsList aria-label="Settings tabs">{SETTINGS_TABS.map(t => <TabsTrigger key={t.id} value={t.id} title={`${t.label} · ⌘${t.shortcut.toUpperCase()}`} className="flex-none px-3 data-[state=active]:bg-selected! data-[state=active]:text-selected-foreground!"><Icon name={t.icon} /><span className="relative pr-1">{t.label}{((t.id === "plugins" && pluginUpdates) || (t.id === "about" && appUpdate)) && <UpdateIndicator className="absolute -right-2 -top-1 ring-0"/>}</span><KeyHint className="ml-1.5 shrink-0" keys={`⌘${t.shortcut.toUpperCase()}`} /></TabsTrigger>)}</TabsList>
                </Tabs>
                <div data-window-drag-handle aria-hidden="true" className="electrobun-webkit-app-region-drag min-w-8 flex-1 self-stretch" />
				<Button variant="ghost" size="icon-sm" className="electrobun-webkit-app-region-no-drag ml-auto -mr-2 text-muted-foreground" onClick={onClose} aria-label="Close settings" title="Close  esc">
					<X />
				</Button>
			</PaneHeader>
			<div key={tab} className="settings-scroll min-h-0 flex-1 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Settings content">
				<div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
                    {tab === "plugins" && <PluginManager />}

                    {tab === "appearance" && <AppearanceSetting />}
                    {tab === "about" && <AboutSettings />}
                    {tab === "keyboard" && <>
                    <SettingsGroup title="Menu bar"><div className="p-5"><ShortcutSetting /></div></SettingsGroup>
                    <SettingsGroup title="Navigation and actions"><div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 p-5 text-sm">
                            <Shortcut label="Switch tool (hold ⌘ to see the numbers)" keys={["⌘1 … ⌘9"]} />
							<Shortcut label="Plugin or Settings tabs" keys={["⌘letter", "⌥⌘1 …"]} />
							<Shortcut label="Switch between tabs and pane content" keys={["F6"]} />
                            <Shortcut label="Next / previous tab" keys={["⌃⇥", "⌃⇧⇥"]} />
							<Shortcut label="Collapse or expand the sidebar" keys={["⌘B"]} />
							<Shortcut label="Filter" keys={["⌘F", "/"]} />
							<Shortcut label="Move through rows · expand / collapse" keys={["↑", "↓", "→", "←"]} />
							<Shortcut label="Row: main action · all actions · deselect" keys={["↵", ".", "esc"]} />
							<Shortcut label="Row action letters — shown on hover and in details" keys={["letter"]} />
							<Shortcut label="“Which one?” menus: pick by number" keys={["1 … 9"]} />
							<Shortcut label="ToolBelt settings (this page)" keys={["⌘,"]} />
							<Shortcut label="Menu bar popover: open a tool in this window (its letter is on the row)" keys={["P", "S", "…"]} />
							<Shortcut label="Dialogs: main action · cancel" keys={["↵", "esc"]} />
							<Shortcut label="Close the window · quit ToolBelt" keys={["⌘W", "⌘Q"]} />
                    </div></SettingsGroup></>}
				</div>
			</div>
		</div>
	);
}

function Shortcut({ label, keys }: { label: string; keys: string[] }) {
	return (
		<>
			<span>{label}</span>
			<KbdGroup>
				{keys.map((k) => (
					<Kbd key={k}>{k}</Kbd>
				))}
			</KbdGroup>
		</>
	);
}

// e.code → the key part of an accelerator.
const CODE_KEYS: Record<string, string> = { Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`", Space: "Space" };
function acceleratorOf(e: KeyboardEvent): string | null {
	const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : CODE_KEYS[e.code];
	if (!key || !(e.metaKey || e.ctrlKey || e.altKey)) return null;
	return [e.metaKey && "Command", e.ctrlKey && "Control", e.altKey && "Option", e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

/** Shows the popover shortcut; "Change" records a new one from the next key combination. */
function ShortcutSetting() {
	const [settings, reload] = useSettings();
	const [recording, setRecording] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!recording) return;
		void rpc.request.pauseShortcut({ paused: true });
		const onKey = async (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") return setRecording(false);
			const accel = acceleratorOf(e);
			if (!accel) return; // still holding modifiers, or a plain key
			const res = await rpc.request.setShortcut({ accelerator: accel });
			setError(res.ok ? null : (res.error ?? "couldn't set it"));
			setRecording(false);
			reload();
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			void rpc.request.pauseShortcut({ paused: false });
		};
	}, [recording, reload]);

	return (
		<div className="flex items-center justify-between gap-6">
			<div className="space-y-1">
				<div className="text-sm font-medium">Popover shortcut</div>
				<p className={cn("text-sm", error || settings?.shortcutError ? "text-destructive" : "text-muted-foreground")}>
					{recording ? "Press the new shortcut — it needs ⌘, ⌃ or ⌥. Esc cancels." : (error ?? settings?.shortcutError ?? "Choose the keyboard shortcut for the popover.")}
				</p>
			</div>
			<div className="flex items-center gap-2">
				<Kbd className={cn("h-7 px-2 text-sm", recording && "animate-pulse")}>{recording ? "…" : (settings?.shortcutLabel ?? "")}</Kbd>
				<Button variant="outline" size="sm" onClick={() => (setError(null), setRecording((r) => !r))}>
					{recording ? (
						<>
							Cancel
							<KeyHint keys="esc" />
						</>
					) : (
						"Change"
					)}
				</Button>
			</div>
		</div>
	);
}

/** Color scheme and palette previews share the same visual vocabulary. */
function AppearancePreview({theme, modes}: {theme: typeof THEMES[number]; modes: ("light" | "dark")[]}) {
    return <div className="flex h-20" aria-hidden="true">{modes.map(mode => {
        const p = tokens(theme[mode]);
        return <div key={mode} className="flex min-w-0 flex-1 gap-2 p-2.5" style={{background:p.background}}>
            <div className="w-1/5 rounded-sm" style={{background:p.sidebar, border:`1px solid ${p.border}`}} />
            <div className="flex flex-1 flex-col gap-1.5"><div className="h-1.5 w-3/4 rounded-full" style={{background:p.foreground}}/><div className="h-1.5 w-1/2 rounded-full" style={{background:p["muted-foreground"]}}/><div className="mt-auto h-3 rounded" style={{background:p.selected}}/></div>
        </div>;
    })}</div>;
}
function AppearanceSetting() {
    const [settings, reload] = useSettings();
    const set = async (value: {theme?: string; mode?: string}) => { await rpc.request.setAppearance(value); reload(); };
    const theme = THEMES.find(t => t.id === settings?.theme) ?? THEMES[0]!;
    const card = (active: boolean) => cn("min-w-0 overflow-hidden rounded-xl border text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring", active ? "ring-2 ring-selected ring-offset-2 ring-offset-card" : "hover:bg-accent hover:shadow-sm");
    return <div className="space-y-8">
        <SettingsGroup title="Color scheme"><div className="p-5"><p className="mb-4 text-sm text-muted-foreground">Use light or dark colors, or follow your system setting.</p><div className="grid max-w-xl grid-cols-1 gap-3 min-[400px]:grid-cols-3">
            {([['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']] as const).map(([mode,label,icon]) => {
                const active = (settings?.mode ?? "system") === mode;
                return <button key={mode} aria-pressed={active} onClick={() => void set({mode})} className={card(active)}>
                    <AppearancePreview theme={theme} modes={mode === "system" ? ["light", "dark"] : [mode]} />
                    <div className="flex items-center gap-2 border-t px-3 py-2 text-sm"><Icon name={icon} className="size-4"/><span>{label}</span>{active && <Check className="ml-auto size-4"/>}</div>
                </button>;
            })}
        </div></div></SettingsGroup>
        <SettingsGroup title="Theme"><div className="p-5"><p className="mb-4 text-sm text-muted-foreground">Choose the palette used for backgrounds, text, and controls.</p><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {THEMES.map(t => {
                const active = (settings?.theme ?? "graphite") === t.id;
                return <button key={t.id} aria-pressed={active} onClick={() => void set({theme:t.id})} className={card(active)}><AppearancePreview theme={t} modes={["light", "dark"]}/><div className="flex items-center justify-between border-t px-3 py-2 text-sm"><span className="font-medium">{t.name}</span>{active && <Check className="size-4"/>}</div></button>;
            })}
        </div></div></SettingsGroup>
    </div>;
}

function AboutSettings() {
 const [legal, setLegal] = useState(false);
 const [acknowledgments, setAcknowledgments] = useState<{name: string; version: string; license: string; text: string; url?: string; licenseUrl?: string}[]>([]);
 useEffect(() => { if (legal) void import("./acknowledgments").then(module => setAcknowledgments(module.acknowledgments)); }, [legal]);
 const [query, setQuery] = useState("");
 const opener = useRef<HTMLButtonElement>(null);
 const back = () => { setLegal(false); requestAnimationFrame(() => opener.current?.focus()); };
 useEffect(() => {
   if (!legal) return;
   const key = (e: KeyboardEvent) => { if (e.key === "Escape" || (e.altKey && e.key === "ArrowLeft")) { e.preventDefault(); e.stopImmediatePropagation(); back(); } };
   window.addEventListener("keydown", key, true);
   return () => window.removeEventListener("keydown", key, true);
 }, [legal]);
 const notices = acknowledgments.filter(d => `${d.name} ${d.version} ${d.license} ${d.text}`.toLowerCase().includes(query.toLowerCase()));
 if (legal) return <section className="space-y-4 animate-in fade-in-0 duration-200 motion-reduce:animate-none">
   <Button variant="ghost" size="sm" onClick={back}><ArrowLeft />About</Button>
   <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-base font-semibold">Third-party notices</h2><span className="text-sm text-muted-foreground">{notices.length} notices</span><input autoFocus aria-label="Search licenses" placeholder="Search licenses" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
   <div className="overflow-hidden rounded-xl border bg-card py-1">{notices.map(d => <details key={`${d.name}@${d.version}`} className="group"><summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-5 py-2 text-sm hover:bg-accent focus-visible:outline-ring"><ChevronRight className="size-4 shrink-0 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"/><span className="min-w-0 break-words font-medium"><LicenseHit text={d.name} query={query}/></span><span className="font-mono text-muted-foreground">{d.version}</span><span className="ml-auto text-xs text-muted-foreground"><LicenseHit text={d.license} query={query}/></span>{d.licenseUrl && <button type="button" aria-label={`Open license for ${d.name}`} title="Open license in browser" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring" onClick={e => { e.preventDefault(); e.stopPropagation(); void rpc.request.openUrl({url:d.licenseUrl!}); }}><ExternalLink className="size-3.5"/></button>}</summary><div className="px-5 pb-5 sm:pl-12"><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground"><LicenseHit text={d.text} query={query}/></pre>{d.licenseUrl && <button className="mt-3 inline-flex items-center gap-1 text-sm hover:underline" onClick={() => rpc.request.openUrl({url:d.licenseUrl!})}>View license<ExternalLink className="size-3"/></button>}{d.url && <button className="ml-4 mt-3 inline-flex items-center gap-1 text-sm hover:underline" onClick={() => rpc.request.openUrl({url:d.url!})}>Project repository<ExternalLink className="size-3"/></button>}</div></details>)}{!notices.length && <p className="p-5 text-sm text-muted-foreground">No matching notices.</p>}</div>
 </section>;
 return <div className="space-y-8"><UpdatesCard /><SettingsGroup title="Legal"><SettingsRow title="Privacy Policy" description="ToolBelt is an installed app and collects no information."/><SettingsRow title="Open source licenses" description="Notices and license terms for dependencies used by ToolBelt."><Button ref={opener} variant="outline" onClick={() => setLegal(true)}>View licenses<ChevronRight /></Button></SettingsRow></SettingsGroup></div>;
}

function LicenseHit({text, query}: {text: string; query: string}) {
    if (!query) return <>{text}</>;
    const lower = text.toLowerCase(), term = query.toLowerCase();
    const parts: ReactNode[] = [];
    let start = 0, at = lower.indexOf(term);
    while (at !== -1) {
        parts.push(text.slice(start, at), <mark className="hit" key={at}>{text.slice(at, at + query.length)}</mark>);
        start = at + query.length;
        at = lower.indexOf(term, start);
    }
    parts.push(text.slice(start));
    return <>{parts}</>;
}
