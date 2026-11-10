// ⌘+ / ⌘- / ⌘0: zoom. The window's text (and the spacing that follows it) scales with the root
// font size; a part of the page can take over zooming while it's on screen (the terminal in the
// output dialog zooms only itself). Each change shows a short-lived indicator, top right.
//
// The commands arrive from the app menu (View → Zoom In…), or as key presses where no menu
// catches them (the browser preview).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommand } from "@/lib/store";
import { usePersisted } from "@/lib/uistate";

export const ZOOM_STEPS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2];
export type ZoomCommand = "zoomIn" | "zoomOut" | "zoomReset";

export function nextZoom(current: number, cmd: ZoomCommand, steps = ZOOM_STEPS): number {
	if (cmd === "zoomReset") return 1;
	const i = steps.findIndex((s) => s >= current - 1e-6);
	const at = i < 0 ? steps.length - 1 : i;
	if (cmd === "zoomIn") return steps[Math.min(steps.length - 1, steps[at] > current + 1e-6 ? at : at + 1)];
	return steps[Math.max(0, at - 1)];
}

// The handler that gets zoom commands: the most recently mounted target, else the window.
type Target = (cmd: ZoomCommand) => void;
const targets: Target[] = [];

function dispatch(cmd: ZoomCommand) {
	targets[targets.length - 1]?.(cmd);
}

/** Take over ⌘+ / ⌘- / ⌘0 while mounted (and `active`). */
export function useZoomTarget(fn: Target, active = true) {
	const ref = useRef(fn);
	ref.current = fn;
	useEffect(() => {
		if (!active) return;
		const t: Target = (c) => ref.current(c);
		targets.push(t);
		return () => void targets.splice(targets.indexOf(t), 1);
	}, [active]);
}

let lastCommand = 0;
/** Wires the menu commands and the keyboard to the zoom targets. Mount once per web view. */
export function ZoomKeys() {
	useCommand(
		useCallback((name: string) => {
			if (name === "zoomIn" || name === "zoomOut" || name === "zoomReset") {
				lastCommand = performance.now();
				dispatch(name);
			}
		}, []),
	);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!e.metaKey || e.ctrlKey || e.altKey) return;
			const cmd: ZoomCommand | null = e.key === "=" || e.key === "+" ? "zoomIn" : e.key === "-" ? "zoomOut" : e.key === "0" ? "zoomReset" : null;
			if (!cmd) return;
			e.preventDefault();
			// The menu already handled this press.
			if (performance.now() - lastCommand < 150) return;
			dispatch(cmd);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return null;
}

/** A zoom level that's remembered, plus a flag that's on for a moment after each change. */
export function useZoomLevel(key: string): [number, (cmd: ZoomCommand) => void, number] {
	const [zoom, setZoom] = usePersisted(key, 1);
	const [shownAt, setShownAt] = useState(0);
	const apply = useCallback(
		(cmd: ZoomCommand) => {
			setZoom(nextZoom(zoom, cmd));
			setShownAt(Date.now());
		},
		[zoom, setZoom],
	);
	return [zoom, apply, shownAt];
}

/** The window's zoom: scales the root font size. */
export function WindowZoom() {
	const [zoom, apply, shownAt] = useZoomLevel("toolbelt.zoom");
	useZoomTarget(apply);
	useEffect(() => {
		document.documentElement.style.fontSize = zoom === 1 ? "" : `${zoom * 100}%`;
	}, [zoom]);
	return <ZoomIndicator zoom={zoom} shownAt={shownAt} className="fixed top-3 right-4 z-[100]" />;
}

/** "125%", shown for a moment after a change: fades and scales in, then out (200 ms each). */
export function ZoomIndicator({ zoom, shownAt, className, label }: { zoom: number; shownAt: number; className?: string; label?: ReactNode }) {
	const [phase, setPhase] = useState<"hidden" | "in" | "out">("hidden");
	useEffect(() => {
		if (!shownAt) return;
		setPhase("in");
		const out = setTimeout(() => setPhase("out"), 1100);
		const gone = setTimeout(() => setPhase("hidden"), 1100 + 200);
		return () => (clearTimeout(out), clearTimeout(gone));
	}, [shownAt]);
	if (phase === "hidden") return null;
	return (
		<div
			role="status"
			aria-live="polite"
			className={cn(
				"pointer-events-none flex items-center gap-1.5 rounded-full border bg-popover/90 px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-lg backdrop-blur-md tabular-nums duration-200",
				phase === "in" ? "animate-in fade-in-0 zoom-in-90 slide-in-from-top-1" : "animate-out fade-out-0 zoom-out-90 fill-mode-forwards",
				className,
			)}
		>
			<ZoomIn className="size-3.5 text-muted-foreground" />
			{label}
			{Math.round(zoom * 100)}%
		</div>
	);
}
