// The main window: the app sidebar (resizable, collapses to an icon rail) and the selected
// plugin's pane with its tabs. Route: #/<plugin>/<screen>, or #/toolbelt for Toolbelt's own page.
//
// Keyboard: ⌘1…9 tools (hold ⌘ to see the numbers) · ⌥⌘1…9 tabs (hold ⌥⌘) · ⌃⇥ / ⌃⇧⇥ next and
// previous tab · ⌘B sidebar · ⌘W closes the window (app menu).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Monitor, Moon, PanelLeft, RotateCw, Settings2, Sun } from "lucide-react";
import { defaultScreen, type Manifest } from "../shared/protocol";
import type { PluginInfo } from "../shared/rpc";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { committed, rpc, sendEvent, useCommand, useNavigate, usePlugins, useSettings, useSurface } from "@/lib/store";
import { THEMES, tokens } from "./themes";
import { QuitDialog } from "./QuitDialog";
import { SurfaceContext, useHeldModifiers, usePersisted } from "@/lib/uistate";
import { EmptyState, Render, Dot } from "@/renderer/Render";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
	const lastScreen = useRef<Record<string, string>>({});
	const [lastPlugin, setLastPlugin] = usePersisted<string | null>("toolbelt.plugin", null);

	useEffect(() => {
		const on = () => setRoute(parseHash());
		window.addEventListener("hashchange", on);
		return () => window.removeEventListener("hashchange", on);
	}, []);
	const go = useCallback((plugin: string, screen?: string) => {
		location.hash = `#/${plugin}${screen ? `/${screen}` : ""}`;
	}, []);
	useNavigate(go);

	// Default route: the remembered plugin, else the first.
	const pluginId = route.plugin ?? lastPlugin ?? plugins[0]?.manifest.id;
	useEffect(() => {
		if (route.plugin) setLastPlugin(route.plugin);
	}, [route.plugin, setLastPlugin]);
	const current = plugins.find((p) => p.manifest.id === pluginId);
	const screen = current ? (route.screen ?? lastScreen.current[current.manifest.id] ?? defaultScreen(current.manifest)) : undefined;
	if (current && screen) lastScreen.current[current.manifest.id] = screen;

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const n = Number(e.key) || Number(e.code.replace("Digit", ""));
			const screens = current?.manifest.screens ?? [];
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
			<AppSidebar plugins={plugins} current={route.plugin === TOOLBELT ? TOOLBELT : pluginId} go={go} onResize={setWidth} />
			<SidebarInset className="min-w-0">
				{route.plugin === TOOLBELT ? (
					<ToolbeltPage plugins={plugins} />
				) : current && screen ? (
					<PluginPane key={current.manifest.id} info={current} screen={screen} go={go} />
				) : plugins.length ? null : (
					<Loading />
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
						<SidebarMenu>
							{plugins.map((p, i) => (
								<SidebarMenuItem key={p.manifest.id}>
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
						<SidebarMenuButton isActive={current === TOOLBELT} tooltip="Toolbelt  ⌘," onClick={() => go(TOOLBELT)} className={ACTIVE}>
							<Settings2 />
							<span>Toolbelt</span>
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
		<Button variant="ghost" size="icon-sm" className="electrobun-webkit-app-region-no-drag text-muted-foreground" onClick={toggleSidebar} aria-label={state === "expanded" ? "Collapse sidebar (⌘B)" : "Expand sidebar (⌘B)"} title={state === "expanded" ? "Collapse sidebar  ⌘B" : "Expand sidebar  ⌘B"}>
			<PanelLeft />
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
		<header onDoubleClick={zoomOnDoubleClick} className="electrobun-webkit-app-region-drag flex h-12 shrink-0 items-center gap-3 border-b pr-6" style={{ paddingLeft: collapsed ? TRAFFIC_LIGHTS_END - RAIL : 24 }}>
			{collapsed && (
				<div className="-ml-1">
					<CollapseButton />
				</div>
			)}
			<div className="flex items-center gap-2.5">
				<div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
					<Icon name={manifest.icon} className="size-4" />
				</div>
				<h1 className="text-sm font-semibold">{manifest.name}</h1>
			</div>
			{children}
		</header>
	);
}

function PluginPane({ info, screen, go }: { info: PluginInfo; screen: string; go: (p: string, s?: string) => void }) {
	const m = info.manifest;
	const hints = useHeldModifiers({ meta: true, alt: true });
	return (
		<div className="flex h-svh min-h-0 flex-col">
			<PaneHeader manifest={m}>
				{m.screens.length > 1 && (
					<Tabs value={screen} onValueChange={(s) => go(m.id, s)} className="electrobun-webkit-app-region-no-drag">
						<TabsList>
							{m.screens.map((s, i) => (
								<TabsTrigger key={s.id} value={s.id} className="gap-1.5 px-3" title={`${s.title}  ⌥⌘${i + 1}`}>
									{s.icon && <Icon name={s.icon} />}
									{s.title}
									{hints && i < 9 && <Kbd className="ml-0.5 h-4 min-w-4 px-1 text-[10px]">{i + 1}</Kbd>}
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
				)}
				{info.state !== "running" && (
					<Badge variant={info.state === "crashed" ? "destructive" : "secondary"} className="electrobun-webkit-app-region-no-drag ml-auto">
						{info.state}
					</Badge>
				)}
			</PaneHeader>
			<div className="min-h-0 flex-1">{info.state === "crashed" ? <Crashed info={info} /> : <Screen key={screen} plugin={m.id} surface={`screen:${screen}`} />}</div>
		</div>
	);
}

function Screen({ plugin, surface }: { plugin: string; surface: string }) {
	const tree = useSurface(plugin, surface);
	const emit = useCallback((name: string, payload?: unknown) => sendEvent(plugin, surface, name, payload), [plugin, surface]);
	useLayoutEffect(() => committed(plugin, surface), [tree, plugin, surface]);
	if (!tree) return <Loading />;
	return (
		<SurfaceContext.Provider value={`${plugin}/${surface}`}>
			<Render node={tree} emit={emit} />
		</SurfaceContext.Provider>
	);
}

function Crashed({ info }: { info: PluginInfo }) {
	return (
		<div className="mx-auto max-w-xl px-6 py-12">
			<EmptyState icon="bug" title={`${info.manifest.name} stopped working`} description="It crashed a few times in a row, so Toolbelt stopped restarting it." />
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

// ── Toolbelt's own page ──────────────────────────────────────────────────
function ToolbeltPage({ plugins }: { plugins: PluginInfo[] }) {
	return (
		<div className="flex h-svh min-h-0 flex-col">
			<PaneHeader manifest={{ name: "Toolbelt", icon: "settings-2" }} />
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
					<AppearanceSetting />
					<Card>
						<CardHeader>
							<CardTitle>Menu bar</CardTitle>
							<CardDescription>Open the menu bar popover from anywhere with a keyboard shortcut.</CardDescription>
						</CardHeader>
						<CardContent>
							<ShortcutSetting />
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Installed tools</CardTitle>
							<CardDescription>Each tool is its own program; Toolbelt starts it and draws its screens.</CardDescription>
						</CardHeader>
						<CardContent className="divide-y">
							{plugins.map((p, i) => (
								<div key={p.manifest.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
									<div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
										<Icon name={p.manifest.icon} className="size-4" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2 text-sm font-medium">
											{p.manifest.name}
											<span className="font-mono text-xs font-normal text-muted-foreground">{p.manifest.version}</span>
											{i < 9 && <Kbd className="text-[10px]">⌘{i + 1}</Kbd>}
										</div>
										<div className="truncate text-sm text-muted-foreground">{p.manifest.description}</div>
									</div>
									<Badge variant="outline" className="gap-1.5">
										<Dot tone={p.state === "running" ? "success" : p.state === "crashed" ? "danger" : "warning"} />
										{p.state}
									</Badge>
									<Button variant="ghost" size="icon-sm" onClick={() => void rpc.request.restartPlugin({ plugin: p.manifest.id })} aria-label="Restart">
										<RotateCw />
									</Button>
								</div>
							))}
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle>Keyboard</CardTitle>
						</CardHeader>
						<CardContent className="grid grid-cols-[1fr_auto] items-center gap-y-3 text-sm">
							<Shortcut label="Switch tool (hold ⌘ to see the numbers)" keys={["⌘1 … ⌘9"]} />
							<Shortcut label="Switch tab (hold ⌥⌘)" keys={["⌥⌘1 … ⌥⌘9"]} />
							<Shortcut label="Next / previous tab" keys={["⌃⇥", "⌃⇧⇥"]} />
							<Shortcut label="Collapse or expand the sidebar" keys={["⌘B"]} />
							<Shortcut label="Filter" keys={["⌘F", "/"]} />
							<Shortcut label="Move through rows · expand / collapse" keys={["↑", "↓", "→", "←"]} />
							<Shortcut label="Row: main action · all actions · deselect" keys={["↵", ".", "esc"]} />
							<Shortcut label="Toolbelt settings (this page)" keys={["⌘,"]} />
							<Shortcut label="Close the window · quit Toolbelt" keys={["⌘W", "⌘Q"]} />
						</CardContent>
					</Card>
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
					{recording ? "Press the new shortcut — it needs ⌘, ⌃ or ⌥. Esc cancels." : (error ?? settings?.shortcutError ?? "Works in any app; no extra permissions needed.")}
				</p>
			</div>
			<div className="flex items-center gap-2">
				<Kbd className={cn("h-7 px-2 text-sm", recording && "animate-pulse")}>{recording ? "…" : (settings?.shortcutLabel ?? "")}</Kbd>
				<Button variant="outline" size="sm" onClick={() => (setError(null), setRecording((r) => !r))}>
					{recording ? "Cancel" : "Change"}
				</Button>
			</div>
		</div>
	);
}

/** Theme swatches (each shows its light and dark half) and the light / dark / system switch. */
function AppearanceSetting() {
	const [settings, reload] = useSettings();
	const set = async (v: { theme?: string; mode?: string }) => {
		await rpc.request.setAppearance(v);
		reload();
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Appearance</CardTitle>
				<CardDescription>Every theme has a light and a dark version, and keeps text at WCAG AA contrast or better.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="flex items-center justify-between gap-6">
					<div className="text-sm font-medium">Mode</div>
					<Tabs value={settings?.mode ?? "system"} onValueChange={(mode) => void set({ mode })}>
						<TabsList>
							<TabsTrigger value="light" className="gap-1.5 px-3">
								<Sun />
								Light
							</TabsTrigger>
							<TabsTrigger value="dark" className="gap-1.5 px-3">
								<Moon />
								Dark
							</TabsTrigger>
							<TabsTrigger value="system" className="gap-1.5 px-3">
								<Monitor />
								System
							</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
					{THEMES.map((t) => {
						const active = (settings?.theme ?? "graphite") === t.id;
						return (
							<button
								key={t.id}
								onClick={() => void set({ theme: t.id })}
								aria-pressed={active}
								className={cn("group overflow-hidden rounded-xl border text-left outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring", active ? "ring-2 ring-selected ring-offset-2 ring-offset-background" : "hover:shadow-md")}
							>
								<div className="flex h-20">
									{(["light", "dark"] as const).map((m) => {
										const p = tokens(t[m]);
										return (
											<div key={m} className="flex flex-1 flex-col gap-1.5 p-2.5" style={{ background: p.background }}>
												<div className="h-1.5 w-3/4 rounded-full" style={{ background: p.foreground }} />
												<div className="h-1.5 w-1/2 rounded-full" style={{ background: p["muted-foreground"] }} />
												<div className="mt-auto flex items-center gap-1">
													<div className="h-3 flex-1 rounded" style={{ background: p.selected }} />
													<div className="size-3 rounded-full" style={{ background: p.primary }} />
												</div>
											</div>
										);
									})}
								</div>
								<div className="flex items-center justify-between border-t px-3 py-2 text-sm">
									<span className="font-medium">{t.name}</span>
									{active && <Check className="size-4" />}
								</div>
							</button>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
