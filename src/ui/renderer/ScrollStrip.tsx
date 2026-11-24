// A row of controls that never wraps: it scrolls sideways (trackpad swipe, touch, a focused
// control coming into view) with no scrollbar. Where controls are cut off, that edge fades and a
// ‹ or › button appears; pressing it scrolls most of a strip's width. The page toolbar uses it.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { revealScroll, stripEdges, stripStep, STRIP_EDGE } from "./pure";

/** Marks the strip's scrolling element, for code that scrolls it while dragging inside it. */
export const SCROLL_STRIP = "data-scroll-strip";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ScrollStrip({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
	const track = useRef<HTMLDivElement>(null);
	const [edges, setEdges] = useState({ left: false, right: false });
	const update = useCallback(() => {
		const el = track.current;
		if (!el) return;
		const next = stripEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
		setEdges((was) => (was.left === next.left && was.right === next.right ? was : next));
	}, []);
	useLayoutEffect(update);
	useEffect(() => {
		const el = track.current;
		if (!el) return;
		// The strip's size and its content's both change what's hidden.
		const observer = new ResizeObserver(update);
		observer.observe(el);
		for (const child of el.children) observer.observe(child);
		const children = new MutationObserver(() => {
			observer.disconnect();
			observer.observe(el);
			for (const child of el.children) observer.observe(child);
			update();
		});
		children.observe(el, { childList: true });
		return () => {
			observer.disconnect();
			children.disconnect();
		};
	}, [update]);
	const scroll = (dir: -1 | 1) => {
		const el = track.current;
		if (el) el.scrollBy({ left: dir * stripStep(el.clientWidth), behavior: reducedMotion() ? "auto" : "smooth" });
	};
	// A control that takes focus (Tab, a shortcut) comes into view clear of the fades.
	const reveal = (e: React.FocusEvent<HTMLDivElement>) => {
		const el = track.current;
		if (!el || e.target === el) return;
		const box = el.getBoundingClientRect(), item = (e.target as HTMLElement).getBoundingClientRect();
		const start = item.left - box.left + el.scrollLeft;
		const left = revealScroll(el.scrollLeft, el.clientWidth, el.scrollWidth, start, start + item.width);
		if (left !== el.scrollLeft) el.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
	};
	const fade = `${STRIP_EDGE}px`;
	const mask = `linear-gradient(to right, transparent 0, #000 ${edges.left ? fade : "0px"}, #000 calc(100% - ${edges.right ? fade : "0px"}), transparent 100%)`;
	return (
		<div className={cn("relative min-w-0", className)}>
			<div
				ref={track}
				{...{ [SCROLL_STRIP]: "" }}
				role={label ? "group" : undefined}
				aria-label={label}
				onScroll={update}
				onFocus={reveal}
				// Room for focus rings, which the scrolling box would clip. `scroll-strip` (index.css)
				// hides the scrollbar: the app's global scrollbar rules outrank utility classes.
				className="scroll-strip -m-1 flex min-w-0 items-center gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain p-1"
				style={{ maskImage: mask, WebkitMaskImage: mask }}
			>
				{children}
			</div>
			<EdgeButton side="left" shown={edges.left} onPress={() => scroll(-1)} />
			<EdgeButton side="right" shown={edges.right} onPress={() => scroll(1)} />
		</div>
	);
}

/** A ‹ or › over a cut-off edge. Pointer only: keyboard users get there by Tab. */
function EdgeButton({ side, shown, onPress }: { side: "left" | "right"; shown: boolean; onPress: () => void }) {
	const Chevron = side === "left" ? ChevronLeft : ChevronRight;
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-hidden
			onClick={onPress}
			// Don't take focus from what has it.
			onMouseDown={(e) => e.preventDefault()}
			// The same edge button as a scrolling tab strip's (components/ui/tabs.tsx).
			className={cn(
				"absolute inset-y-0 z-10 flex w-6 items-center justify-center bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
				"transition-opacity duration-200 ease-out motion-reduce:transition-none",
				side === "left" ? "left-0 rounded-l-lg" : "right-0 rounded-r-lg",
				shown ? "opacity-100" : "pointer-events-none opacity-0 duration-150",
			)}
		>
			<Chevron className="size-3.5" />
		</button>
	);
}
