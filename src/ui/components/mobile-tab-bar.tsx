import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useRovingFocus } from "@/lib/keyboard";

export type MobileTab = { id: string; label: string; icon: ReactNode; indicator?: ReactNode };

/**
 * On narrow screens a plugin's tabs (and Settings') sit in a bar along the bottom, in reach of a
 * thumb, instead of a header strip that scrolls. Icon over a short label; the chosen tab's icon
 * sits in a pill of the selection color. It keeps clear of the home indicator.
 */
export function MobileTabBar({ tabs, value, onChange, label, hidden = false }: { tabs: MobileTab[]; value: string; onChange: (id: string) => void; label: string; /** slid away (`SlideAway`): nothing needs to float above it */ hidden?: boolean }) {
	const list = useRef<HTMLDivElement>(null);
	const bar = useRef<HTMLElement>(null);
	// Its height, for what floats above it (toasts, the install card): `--mobile-tab-bar`.
	useLayoutEffect(() => {
		const el = bar.current;
		if (!el) return;
		const root = document.documentElement;
		const set = () => root.style.setProperty("--mobile-tab-bar", hidden ? "0px" : `${el.offsetHeight}px`);
		const observer = new ResizeObserver(set);
		observer.observe(el);
		set();
		return () => {
			observer.disconnect();
			root.style.removeProperty("--mobile-tab-bar");
		};
	}, [hidden]);
	const roving = useRovingFocus(list, { items: "[role=tab]", current: "[aria-selected=true]", orientation: "horizontal", selectOnFocus: true });
	return (
		<nav ref={bar} aria-label={label} className="shrink-0 border-t bg-background/95 pb-[max(env(safe-area-inset-bottom),0.25rem)] backdrop-blur supports-[backdrop-filter]:bg-background/85">
			<div ref={list} role="tablist" aria-label={label} onKeyDown={roving} className="no-scrollbar flex overflow-x-auto px-[max(env(safe-area-inset-left),0.25rem)]">
				{tabs.map((t) => {
					const active = t.id === value;
					return (
						<button
							key={t.id}
							type="button"
							role="tab"
							aria-selected={active}
							tabIndex={active ? 0 : -1}
							onClick={() => onChange(t.id)}
							className={cn("group flex min-w-16 flex-1 basis-0 flex-col items-center gap-0.5 px-1 pt-1.5 pb-1 text-[11px] leading-tight outline-none select-none [-webkit-touch-callout:none]", active ? "font-medium text-foreground" : "text-muted-foreground")}
						>
							<span className={cn("relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200 ease-out group-focus-visible:ring-2 group-focus-visible:ring-ring [&_svg]:size-[1.15rem]", active ? "bg-selected text-selected-foreground" : "group-active:bg-accent")}>
								{t.icon}
								{t.indicator && <span className="absolute top-0.5 right-2 inline-flex">{t.indicator}</span>}
							</span>
							<span className="max-w-full truncate">{t.label}</span>
						</button>
					);
				})}
			</div>
		</nav>
	);
}

/**
 * A bar that slides off its edge of the screen while content scrolls (`useHideOnScroll`), giving
 * its room to the content: the row it sits in collapses, so the bar moves out as the content
 * grows. Focus moving into it (a keyboard) brings it back.
 */
export function SlideAway({ hidden, edge, onFocus, children }: { hidden: boolean; edge: "top" | "bottom"; onFocus: () => void; children: ReactNode }) {
	return (
		<div data-hide-on-scroll className={cn("grid shrink-0 transition-[grid-template-rows] ease-out motion-reduce:transition-none", hidden ? "grid-rows-[0fr] duration-200" : "grid-rows-[1fr] duration-200")} onFocusCapture={onFocus}>
			{/* The top bar stays pinned to the bottom of its shrinking row, so it slides up and out. */}
			<div className={cn("flex min-h-0 flex-col overflow-hidden", edge === "top" && "justify-end")}>{children}</div>
		</div>
	);
}
