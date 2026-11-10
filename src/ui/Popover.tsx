// The menu bar popover: the installed tools, and a tool's quick view when you pick one.
//
// Keyboard — tools: ↑/↓ choose · ↵ or → open · a letter (shown on the row) opens that tool in the
// window · ⌘↵ open in the window · esc close.
// Quick view: ↑/↓ items · ↵ item's action · ← or esc back · ⌘↵ open in the window.
//
// The tool list is as tall as its tools (up to six rows, then it scrolls) and tells the main
// process how tall to make the window; a quick view gets the full height.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Power } from "lucide-react";
import { defaultScreen } from "../shared/protocol";
import { assignLetters } from "../shared/letters";
import type { PluginInfo } from "../shared/rpc";
import { Icon } from "@/lib/icon";
import { rpc, sendEvent, usePlugins, usePopoverHiding, usePopoverShown, useSettings, useSurface } from "@/lib/store";
import { SurfaceContext, isTyping } from "@/lib/uistate";
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

export default function Popover() {
	const plugins = usePlugins();
    const development = useUpdateState()?.channel === "dev";
	const [settings] = useSettings();
	const [open, setOpen] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	// Each showing plays the opening animation (a new key restarts it); hiding plays the closing one.
	const [shown, setShown] = useState({ n: 0, closing: false });
	usePopoverShown(
		useCallback(() => {
			setOpen(null);
			setActive(0);
			setShown((s) => ({ n: s.n + 1, closing: false }));
			window.focus(); // take the keyboard
		}, []),
	);
	usePopoverHiding(useCallback(() => setShown((s) => ({ ...s, closing: true })), []));
	const current = plugins.find((p) => p.manifest.id === open);
	const letters = useMemo(() => assignLetters(plugins.map((p) => ({ id: p.manifest.id, name: p.manifest.name }))), [plugins]);

	// Size the window to the list; a quick view takes the full height.
	const box = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (current) {
			rpc.send.popoverSize({ height: null });
			return;
		}
		const el = box.current;
		if (!el) return;
		let last = 0;
		const report = () => {
			if (el.offsetHeight !== last) rpc.send.popoverSize({ height: (last = el.offsetHeight) });
		};
		report();
		const ro = new ResizeObserver(report);
		ro.observe(el);
		return () => ro.disconnect();
	}, [current, shown.n]);
	// Keep the chosen tool in view when the list scrolls.
	useEffect(() => {
		if (!current) box.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active, current]);

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
			} else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
				// A tool's letter opens it in the window; 1…9 open the nth tool here.
				const byLetter = plugins.find((p) => letters.get(p.manifest.id) === e.key.toLowerCase());
				const n = Number(e.key);
				if (byLetter) {
					e.preventDefault();
					rpc.send.showWindow({ plugin: byLetter.manifest.id, screen: defaultScreen(byLetter.manifest) });
				} else if (n >= 1 && n <= 9 && plugins[n - 1]) (e.preventDefault(), setActive(n - 1), pick(plugins[n - 1]));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [current, plugins, active, pick, letters]);

	return (
		<div
			key={shown.n}
			ref={box}
			className={cn(
				"flex origin-top-left flex-col overflow-hidden rounded-xl border bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur-xl",
				// The list keeps its natural height (measured above), even if the window is still smaller.
				current && "h-svh",
				shown.closing ? "animate-out fade-out-0 zoom-out-95 slide-out-to-top-1 fill-mode-forwards duration-150" : "animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200",
			)}
		>
			{current ? (
				<div key={current.manifest.id} className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-right-4 duration-200">
					<QuickView info={current} back={() => setOpen(null)} />
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 slide-in-from-left-4 duration-200">
					<div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
						<span className="text-sm font-semibold">{development ? "Toolbelt Dev" : "Toolbelt"}</span>
						{settings && <Kbd className="ml-auto">{settings.shortcutLabel}</Kbd>}
					</div>
					<PopoverUpdateRow />
					{/* Six rows, then it scrolls (without a scroll bar). */}
					<div className="no-scrollbar max-h-[calc(6*3.25rem+0.5rem)] min-h-0 overflow-auto px-2 pb-2">
						{plugins.map((p, i) => (
							<button
								key={p.manifest.id}
								data-index={i}
								data-active={i === active}
								onMouseEnter={() => setActive(i)}
								onClick={() => pick(p)}
								className="group flex h-13 w-full items-center gap-3 rounded-lg px-2.5 text-left outline-none data-[active=true]:bg-selected data-[active=true]:text-selected-foreground"
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
								{letters.has(p.manifest.id) && (
									<Kbd className="uppercase group-data-[active=true]:bg-selected-foreground/15 group-data-[active=true]:text-selected-foreground" title={`${letters.get(p.manifest.id)!.toUpperCase()} opens ${p.manifest.name} in the window`}>
										{letters.get(p.manifest.id)}
									</Kbd>
								)}
								<ChevronRight className={cn("size-4 text-muted-foreground/50", i === active && "text-selected-foreground")} />
							</button>
						))}
					</div>
					<div className="flex items-center gap-1 border-t px-2 py-1.5">
						<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => rpc.send.showWindow({})}>
							<Maximize2 />
							Open Toolbelt
							<KeyHint keys="⌘↵" />
						</Button>
						<Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={askQuit}>
							<Power />
							Quit
							<KeyHint keys="⌘Q" />
						</Button>
					</div>
				</div>
			)}
			<QuitDialog />
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
				<Button variant="ghost" size="sm" className="gap-1 px-1.5 text-muted-foreground" onClick={back} aria-label="Back" title="Back  ← or esc">
					<ChevronLeft />
					<KeyHint keys="esc" />
				</Button>
				<Icon name={m.icon} className="size-4" />
				<span className="ml-1 text-sm font-semibold">{m.name}</span>
				<Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => rpc.send.showWindow({ plugin: m.id, screen: defaultScreen(m) })} title="Open in the Toolbelt window">
					<Maximize2 />
					Open
					<KeyHint keys="⌘↵" />
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
