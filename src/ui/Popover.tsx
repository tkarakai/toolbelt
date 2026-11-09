// The menu bar popover: the installed tools, and a tool's quick view when you pick one.
//
// Keyboard — tools: ↑/↓ choose · ↵ or → open · ⌘↵ open in the window · esc close.
// Quick view: ↑/↓ items · ↵ item's action · ← or esc back · ⌘↵ open in the window.
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Power } from "lucide-react";
import { defaultScreen } from "../shared/protocol";
import type { PluginInfo } from "../shared/rpc";
import { Icon } from "@/lib/icon";
import { rpc, sendEvent, usePlugins, usePopoverShown, useSettings, useSurface } from "@/lib/store";
import { SurfaceContext, isTyping } from "@/lib/uistate";
import { Dot, Render } from "@/renderer/Render";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function Popover() {
	const plugins = usePlugins();
	const [settings] = useSettings();
	const [open, setOpen] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	usePopoverShown(
		useCallback(() => {
			setOpen(null);
			setActive(0);
			window.focus(); // take the keyboard
		}, []),
	);
	const current = plugins.find((p) => p.manifest.id === open);

	const pick = useCallback((p: PluginInfo) => {
		if (p.manifest.quickView) setOpen(p.manifest.id);
		else rpc.send.showWindow({ plugin: p.manifest.id });
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTyping(e)) return;
			if (e.metaKey && e.key === "Enter") {
				e.preventDefault();
				const p = current ?? plugins[active];
				rpc.send.showWindow(p ? { plugin: p.manifest.id, screen: defaultScreen(p.manifest) } : {});
				return;
			}
			if (current) {
				if (e.key === "Escape" || e.key === "ArrowLeft" || e.key === "Backspace") (e.preventDefault(), setOpen(null));
				return; // the quick view's list handles ↑/↓/↵
			}
			if (e.key === "Escape") (e.preventDefault(), rpc.send.hidePopover({}));
			else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				setActive((i) => Math.max(0, Math.min(plugins.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
			} else if ((e.key === "Enter" || e.key === "ArrowRight") && plugins[active]) {
				e.preventDefault();
				pick(plugins[active]);
			} else {
				// 1…9 jump straight to a tool.
				const n = Number(e.key);
				if (n >= 1 && n <= 9 && plugins[n - 1]) (e.preventDefault(), setActive(n - 1), pick(plugins[n - 1]));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [current, plugins, active, pick]);

	return (
		<div className="flex h-svh flex-col overflow-hidden rounded-xl border bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur-xl">
			{current ? (
				<QuickView info={current} back={() => setOpen(null)} />
			) : (
				<>
					<div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
						<span className="text-sm font-semibold">Toolbelt</span>
						{settings && <Kbd className="ml-auto">{settings.shortcutLabel}</Kbd>}
					</div>
					<div className="flex-1 overflow-auto px-2 pb-2">
						{plugins.map((p, i) => (
							<button
								key={p.manifest.id}
								data-active={i === active}
								onMouseEnter={() => setActive(i)}
								onClick={() => pick(p)}
								className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none data-[active=true]:bg-selected data-[active=true]:text-selected-foreground"
							>
								<div className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-foreground">
									<Icon name={p.manifest.icon} className="size-4" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2 text-sm font-medium">
										{p.manifest.name}
										{p.state !== "running" && <Dot tone={p.state === "crashed" ? "danger" : "warning"} />}
									</div>
									<div className="truncate text-xs text-muted-foreground">{p.manifest.description}</div>
								</div>
								{p.badge !== null && (
									<Badge variant="secondary" className="tabular-nums">
										{p.badge}
									</Badge>
								)}
								<ChevronRight className={cn("size-4 text-muted-foreground/50", i === active && "text-selected-foreground")} />
							</button>
						))}
					</div>
					<div className="flex items-center gap-1 border-t px-2 py-1.5">
						<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => rpc.send.showWindow({})}>
							<Maximize2 />
							Open Toolbelt
							<Kbd className="ml-1">⌘↵</Kbd>
						</Button>
						<Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => rpc.send.quit({})}>
							<Power />
							Quit
						</Button>
					</div>
				</>
			)}
		</div>
	);
}

function QuickView({ info, back }: { info: PluginInfo; back: () => void }) {
	const m = info.manifest;
	const tree = useSurface(m.id, "quick");
	const emit = useCallback((name: string, payload?: unknown) => sendEvent(m.id, "quick", name, payload), [m.id]);
	return (
		<>
			<div className="flex items-center gap-1 border-b px-2 py-2">
				<Button variant="ghost" size="icon-sm" onClick={back} aria-label="Back" title="Back  ←">
					<ChevronLeft />
				</Button>
				<Icon name={m.icon} className="size-4" />
				<span className="ml-1 text-sm font-semibold">{m.name}</span>
				<Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => rpc.send.showWindow({ plugin: m.id, screen: defaultScreen(m) })} title="Open in the Toolbelt window">
					<Maximize2 />
					Open
					<Kbd className="ml-1">⌘↵</Kbd>
				</Button>
			</div>
			<div className="flex-1 overflow-auto p-2">
				{tree ? (
					<SurfaceContext.Provider value={`${m.id}/quick`}>
						<Render node={tree} emit={emit} />
					</SurfaceContext.Provider>
				) : (
					<div className="space-y-2 p-1">
						{Array.from({ length: 5 }, (_, i) => (
							<Skeleton key={i} className="h-10 w-full" />
						))}
					</div>
				)}
			</div>
		</>
	);
}
