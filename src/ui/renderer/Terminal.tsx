// The `terminal` node: output drawn by a real terminal emulator (xterm.js) — ANSI colors and
// styles, long lines wrapped to the width and re-wrapped when it changes, its own scrollback and
// text selection. New output is appended when it continues what's shown (so scrolling and
// selection survive an update); otherwise the screen is redrawn. ⌘+ / ⌘- / ⌘0 zoom its text
// while it's on screen.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { WrapText } from "lucide-react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Node } from "../../shared/protocol";
import { continuation, looksLikeScreen, visibleWidth } from "./pure";
import { cn } from "@/lib/utils";
import { useZoomLevel, useZoomTarget, ZoomIndicator } from "@/lib/zoom";
import { usePersisted } from "@/lib/uistate";
import { Button } from "@/components/ui/button";

type TerminalNode = Extract<Node, { type: "terminal" }>;

/** A CSS color (any syntax, oklch included) as #rrggbb, via a 1 px canvas. */
function toHex(css: string, fallback: string): string {
	try {
		const c = document.createElement("canvas");
		c.width = c.height = 1;
		const ctx = c.getContext("2d", { willReadFrequently: true })!;
		ctx.fillStyle = fallback;
		ctx.fillStyle = css;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
	} catch {
		return fallback;
	}
}

function themeFrom(el: HTMLElement): ITheme {
	const s = getComputedStyle(el);
	const v = (name: string, fb: string) => toHex(s.getPropertyValue(name).trim() || fb, fb);
	const dark = document.documentElement.classList.contains("dark");
	const bg = v("--muted", dark ? "#262626" : "#f5f5f5");
	const fg = v("--foreground", dark ? "#fafafa" : "#171717");
	return {
		background: bg,
		foreground: fg,
		cursor: bg, // no visible cursor: this is a view, not a shell
		cursorAccent: bg,
		selectionBackground: dark ? "#3b82f680" : "#3b82f640",
		// Readable on both backgrounds: Tailwind's 600s on light, 400s on dark.
		...(dark
			? { black: "#52525b", red: "#f87171", green: "#4ade80", yellow: "#facc15", blue: "#60a5fa", magenta: "#e879f9", cyan: "#22d3ee", white: "#e4e4e7", brightBlack: "#71717a", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#f0abfc", brightCyan: "#67e8f9", brightWhite: "#fafafa" }
			: { black: "#27272a", red: "#dc2626", green: "#16a34a", yellow: "#ca8a04", blue: "#2563eb", magenta: "#c026d3", cyan: "#0891b2", white: "#a1a1aa", brightBlack: "#52525b", brightRed: "#ef4444", brightGreen: "#22c55e", brightYellow: "#eab308", brightBlue: "#3b82f6", brightMagenta: "#d946ef", brightCyan: "#06b6d4", brightWhite: "#71717a" }),
	};
}

const baseFontSize = () => (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.75;

export function TerminalView({ node, className }: { node: TerminalNode; className?: string }) {
	const host = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const term = useRef<XTerm | null>(null);
	const fit = useRef<FitAddon | null>(null);
	const shown = useRef<string[]>([]);
	const [zoom, applyZoom, zoomShownAt] = useZoomLevel("toolbelt.terminalZoom");
	useZoomTarget(applyZoom);
	// Wrapping: on for plain output; off (scroll sideways) for a full-screen program drawn wider
	// than the view. The person's choice wins.
	const [wrapChoice, setWrapChoice] = usePersisted<boolean | null>("toolbelt.terminalWrap", null);
	const screenLike = useMemo(() => looksLikeScreen(node.lines), [node.lines]);
	const wrap = wrapChoice ?? !screenLike;
	const widest = useMemo(() => node.lines.reduce((m, l) => Math.max(m, visibleWidth(l)), 0), [node.lines]);
	const [fitCols, setFitCols] = useState(0);

	// Create the emulator once.
	useLayoutEffect(() => {
		const el = host.current!;
		const t = new XTerm({
			convertEol: true,
			disableStdin: true,
			cursorBlink: false,
			cursorInactiveStyle: "none",
			scrollback: 10_000,
			fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
			fontSize: Math.round(baseFontSize() * zoom),
			lineHeight: 1.25,
			allowProposedApi: false,
			theme: themeFrom(el),
		});
		const f = new FitAddon();
		t.loadAddon(f);
		t.open(el);
		term.current = t;
		fit.current = f;
		const measure = () => {
			try {
				const d = f.proposeDimensions();
				if (d) setFitCols(d.cols);
			} catch {}
		};
		requestAnimationFrame(measure);
		const ro = new ResizeObserver(measure);
		ro.observe(scroller.current!);
		// The theme follows light / dark switches.
		const mo = new MutationObserver(() => (t.options.theme = themeFrom(el)));
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
		// ⌘C (the Edit menu's Copy) copies the terminal's selection.
		const onCopy = (e: ClipboardEvent) => {
			if (!t.hasSelection()) return;
			e.clipboardData?.setData("text/plain", t.getSelection());
			e.preventDefault();
		};
		document.addEventListener("copy", onCopy);
		return () => {
			document.removeEventListener("copy", onCopy);
			ro.disconnect();
			mo.disconnect();
			t.dispose();
			term.current = null;
			shown.current = [];
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// New output: append what continues the screen, else redraw.
	useEffect(() => {
		const t = term.current;
		if (!t) return;
		const next = node.lines;
		const prev = shown.current;
		const tail = continuation(prev, next);
		if (tail) {
			if (tail.length) t.write("\r\n" + tail.join("\r\n"));
		} else if (next.join("\n") !== prev.join("\n")) {
			t.reset();
			t.write(next.join("\r\n"), () => node.follow !== false && t.scrollToBottom());
		}
		shown.current = next;
	}, [node.lines, node.follow]);

	useEffect(() => {
		const t = term.current;
		if (!t) return;
		t.options.fontSize = Math.round(baseFontSize() * zoom);
		try {
			const d = fit.current?.proposeDimensions();
			if (d) setFitCols(d.cols);
		} catch {}
	}, [zoom]);

	// Size the emulator: the view's width when wrapping, else wide enough for the widest line.
	useEffect(() => {
		const t = term.current;
		const f = fit.current;
		if (!t || !f || !fitCols) return;
		try {
			const d = f.proposeDimensions();
			if (!d) return;
			const cols = wrap ? d.cols : Math.max(d.cols, Math.min(500, widest + 1));
			if (cols !== t.cols || d.rows !== t.rows) t.resize(cols, d.rows);
		} catch {}
	}, [fitCols, wrap, widest]);

	return (
		<div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-muted", className)}>
			<div ref={scroller} className={cn("min-h-0 flex-1 py-2 pl-3", wrap ? "overflow-hidden" : "overflow-x-auto overflow-y-hidden")}>
				<div ref={host} className="tb-terminal h-full select-text" />
			</div>
			<Button
				variant="ghost"
				size="icon-xs"
				onClick={() => setWrapChoice(!wrap)}
				aria-pressed={wrap}
				title={wrap ? "Wrap long lines (on)" : "Wrap long lines (off)"}
				className={cn("absolute right-4 bottom-2 z-10 bg-muted/80 backdrop-blur", wrap ? "text-foreground" : "text-muted-foreground")}
			>
				<WrapText />
			</Button>
			{!node.lines.length && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{node.empty ?? "No output."}</div>}
			<ZoomIndicator zoom={zoom} shownAt={zoomShownAt} className="absolute top-2 right-3 z-10" label={<span className="text-muted-foreground">Terminal</span>} />
		</div>
	);
}
