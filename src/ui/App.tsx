// The main window: the app sidebar (resizable, collapses to an icon rail) and the selected
// plugin's pane with its tabs. Route: #/<plugin>/<screen>, or #/toolbelt for Toolbelt's own page.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { PanelLeft, RotateCw, Settings2 } from "lucide-react";
import { defaultScreen, type Manifest } from "../shared/protocol";
import type { PluginInfo } from "../shared/rpc";
import { Icon } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { committed, rpc, sendEvent, useNavigate, usePlugins, useSurface } from "@/lib/store";
import { EmptyState, Render, Dot } from "@/renderer/Render";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
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

function parseHash(): { plugin?: string; screen?: string } {
	const [, plugin, screen] = location.hash.replace(/^#/, "").split("/");
	return { plugin: plugin || undefined, screen: screen || undefined };
}

const store = {
	get: (k: string) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	},
	set: (k: string, v: string) => {
		try {
			localStorage.setItem(k, v);
		} catch {}
	},
};

export default function App() {
	const plugins = usePlugins();
	const [route, setRoute] = useState(parseHash);
	const lastScreen = useRef<Record<string, string>>({});

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
	const pluginId = route.plugin ?? store.get("toolbelt.plugin") ?? plugins[0]?.manifest.id;
	useEffect(() => {
		if (route.plugin) store.set("toolbelt.plugin", route.plugin);
	}, [route.plugin]);
	const current = plugins.find((p) => p.manifest.id === pluginId);
	const screen = current ? (route.screen ?? lastScreen.current[current.manifest.id] ?? defaultScreen(current.manifest)) : undefined;
	if (current && screen) lastScreen.current[current.manifest.id] = screen;

	// ⌘1…⌘9 switch tabs within the app; ⌃1…⌃9 switch apps.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const n = Number(e.key);
			if (!n) return;
			if (e.metaKey && current) {
				const s = current.manifest.screens[n - 1];
				if (s) (e.preventDefault(), go(current.manifest.id, s.id));
			} else if (e.ctrlKey) {
				const p = plugins[n - 1];
				if (p) (e.preventDefault(), go(p.manifest.id));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [current, plugins, go]);

	const [width, setWidth] = useState(() => Number(store.get("toolbelt.sidebarWidth")) || 240);
	const [open, setOpen] = useState(() => store.get("toolbelt.sidebarOpen") !== "false");

	return (
		<SidebarProvider
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				store.set("toolbelt.sidebarOpen", String(o));
			}}
			style={{ "--sidebar-width": `${width}px` } as CSSProperties}
		>
			<AppSidebar plugins={plugins} current={route.plugin === TOOLBELT ? TOOLBELT : pluginId} go={go} onResize={(w) => (setWidth(w), store.set("toolbelt.sidebarWidth", String(w)))} />
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

// ── sidebar ──────────────────────────────────────────────────────────────
function AppSidebar({ plugins, current, go, onResize }: { plugins: PluginInfo[]; current?: string; go: (p: string, s?: string) => void; onResize: (w: number) => void }) {
	const { state, setOpen } = useSidebar();
	return (
		<Sidebar collapsible="icon" className="border-r-0">
			{/* Room for the traffic lights; the strip drags the window. */}
			<SidebarHeader className="electrobun-webkit-app-region-drag h-12 shrink-0 flex-row items-center justify-end px-3 group-data-[collapsible=icon]:h-20 group-data-[collapsible=icon]:items-end group-data-[collapsible=icon]:justify-center">
				<CollapseButton />
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Tools</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							{plugins.map((p, i) => (
								<SidebarMenuItem key={p.manifest.id}>
									<SidebarMenuButton isActive={current === p.manifest.id} tooltip={p.manifest.name} onClick={() => go(p.manifest.id)} className="h-9">
										<Icon name={p.manifest.icon} />
										<span className="truncate">{p.manifest.name}</span>
										{p.state !== "running" && <Dot tone={p.state === "crashed" ? "danger" : "warning"} className="ml-auto group-data-[collapsible=icon]:hidden" />}
										<Kbd className="ml-auto hidden opacity-0 group-hover/menu-item:opacity-100 xl:inline-flex group-data-[collapsible=icon]:hidden">⌃{i + 1}</Kbd>
									</SidebarMenuButton>
									{p.badge !== null && p.badge !== undefined && <SidebarMenuBadge className="tabular-nums">{p.badge}</SidebarMenuBadge>}
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton isActive={current === TOOLBELT} tooltip="Toolbelt" onClick={() => go(TOOLBELT)}>
							<Settings2 />
							<span>Toolbelt</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<ResizeHandle
				onResize={onResize}
				onCollapse={() => setOpen(false)}
				onExpand={() => setOpen(true)}
				collapsed={state === "collapsed"}
			/>
		</Sidebar>
	);
}

function CollapseButton() {
	const { toggleSidebar } = useSidebar();
	return (
		<Button variant="ghost" size="icon-sm" className="electrobun-webkit-app-region-no-drag text-muted-foreground" onClick={toggleSidebar} aria-label="Toggle sidebar">
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
	return <div onPointerDown={onPointerDown} onDoubleClick={() => (collapsed ? onExpand() : onCollapse())} className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-border after:transition-colors hover:after:bg-ring/60" />;
}

// ── plugin pane ──────────────────────────────────────────────────────────
function PaneHeader({ manifest, children }: { manifest: Pick<Manifest, "name" | "icon" | "description">; children?: React.ReactNode }) {
	return (
		<header className="electrobun-webkit-app-region-drag flex h-12 shrink-0 items-center gap-3 border-b px-6 group-has-data-[state=collapsed]/sidebar-wrapper:pl-6">
			<div className="flex items-center gap-2.5">
				<div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
					<Icon name={manifest.icon} className="size-4" />
				</div>
				<h1 className="text-sm font-semibold">{manifest.name}</h1>
			</div>
			<div className="electrobun-webkit-app-region-no-drag flex flex-1 items-center gap-3">{children}</div>
		</header>
	);
}

function PluginPane({ info, screen, go }: { info: PluginInfo; screen: string; go: (p: string, s?: string) => void }) {
	const m = info.manifest;
	return (
		<div className="flex h-svh min-h-0 flex-col">
			<PaneHeader manifest={m}>
				{m.screens.length > 1 && (
					<Tabs value={screen} onValueChange={(s) => go(m.id, s)}>
						<TabsList>
							{m.screens.map((s) => (
								<TabsTrigger key={s.id} value={s.id} className="gap-1.5 px-3">
									{s.icon && <Icon name={s.icon} />}
									{s.title}
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
				)}
				{info.state !== "running" && (
					<Badge variant={info.state === "crashed" ? "destructive" : "secondary"} className="ml-auto">
						{info.state}
					</Badge>
				)}
			</PaneHeader>
			<div className="min-h-0 flex-1">
				{info.state === "crashed" ? (
					<Crashed info={info} />
				) : (
					<Screen key={screen} plugin={m.id} surface={`screen:${screen}`} />
				)}
			</div>
		</div>
	);
}

function Screen({ plugin, surface }: { plugin: string; surface: string }) {
	const tree = useSurface(plugin, surface);
	const emit = useCallback((name: string, payload?: unknown) => sendEvent(plugin, surface, name, payload), [plugin, surface]);
	useLayoutEffect(() => committed(plugin, surface), [tree, plugin, surface]);
	if (!tree) return <Loading />;
	return <Render node={tree} emit={emit} />;
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
					<Card>
						<CardHeader>
							<CardTitle>Installed tools</CardTitle>
							<CardDescription>Each tool is its own program; Toolbelt starts it and draws its screens.</CardDescription>
						</CardHeader>
						<CardContent className="divide-y">
							{plugins.map((p) => (
								<div key={p.manifest.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
									<div className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
										<Icon name={p.manifest.icon} className="size-4" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2 text-sm font-medium">
											{p.manifest.name}
											<span className="font-mono text-xs font-normal text-muted-foreground">{p.manifest.version}</span>
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
							<CardTitle>Shortcuts</CardTitle>
						</CardHeader>
						<CardContent className="grid grid-cols-[1fr_auto] gap-y-3 text-sm">
							<span>Menu bar popover, from anywhere</span>
							<Kbd>⌃⌥⇧T</Kbd>
							<span>Switch tool</span>
							<Kbd>⌃1 … ⌃9</Kbd>
							<span>Switch tab</span>
							<Kbd>⌘1 … ⌘9</Kbd>
							<span>Move through rows · clear selection</span>
							<span className={cn("flex gap-1")}>
								<Kbd>↑</Kbd>
								<Kbd>↓</Kbd>
								<Kbd>esc</Kbd>
							</span>
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
