// A draggable edge that the keyboard can use too (the ARIA window-splitter pattern): it takes
// focus, ←/→ (or ↑/↓) resize by a step (×5 with ⇧), Home/End go to the limits, ↵ resets.
// The pointer side stays the caller's: pass its own `onPointerDown`/`onDoubleClick`.
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { resizeKey } from "@/lib/keys";

export function ResizeHandle({ label, value, min, max, step, grows = "ArrowRight", onResize, onReset, hint, className, children, ...props }: Omit<ComponentProps<"div">, "onResize"> & {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	/** The arrow that makes the thing larger (→ for an edge on its right, ← for one on its left). */
	grows?: "ArrowRight" | "ArrowLeft" | "ArrowDown" | "ArrowUp";
	onResize: (value: number) => void;
	onReset?: () => void;
	/** What the keys do, shown beside the edge while it has keyboard focus (`FocusHint`). */
	hint?: string;
}) {
	const vertical = grows === "ArrowRight" || grows === "ArrowLeft";
	const keys = hint ?? `${vertical ? "← →" : "↑ ↓"} resize · ⇧ faster${onReset ? " · ↵ reset" : ""}`;
	return (
		<div
			role="separator"
			tabIndex={0}
			aria-label={label}
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-valuenow={Math.round(value)}
			aria-valuemin={Math.round(min)}
			aria-valuemax={Math.round(max)}
			data-key-hint={keys}
			{...{ "aria-description": keys }}
			onKeyDown={(e) => {
				if (e.metaKey || e.ctrlKey || e.altKey) return;
				if (e.key === "Enter" && onReset) {
					e.preventDefault();
					e.stopPropagation();
					onReset();
					return;
				}
				const next = resizeKey(e.key, e.shiftKey, value, { min, max, step, grows });
				if (next === null) return;
				e.preventDefault();
				e.stopPropagation();
				if (next !== value) onResize(next);
			}}
			className={cn("outline-none focus-visible:after:bg-ring! focus-visible:after:w-0.5!", className)}
			{...props}
		>
			{children}
		</div>
	);
}
