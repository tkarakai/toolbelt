import { useLayoutEffect, useRef } from "react";
import type { PopoverLayout } from "../shared/popover";

export type QuickViewExit = { id: number; element: HTMLElement; layout: PopoverLayout };
let nextExit = 0;

/** A frozen DOM snapshot has no React handlers or plugin subscriptions. It can finish
 * closing while the live quick view immediately releases its surface and keyboard. */
export function captureQuickViewExit(element: HTMLElement, layout: PopoverLayout): QuickViewExit {
  const snapshot = element.cloneNode(true) as HTMLElement;
  const style = getComputedStyle(element);
  snapshot.inert = true;
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.removeAttribute("aria-label");
  snapshot.dataset.keyboardPane = "exit";
  snapshot.dataset.keyboardActive = "false";
  snapshot.dataset.quickViewExit = "true";
  snapshot.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
  Object.assign(snapshot.style, {
    transition: "none", pointerEvents: "none", transform: style.transform,
    transformOrigin: style.transformOrigin, opacity: style.opacity,
  });
  return { id: ++nextExit, element: snapshot, layout };
}

export function quickViewOrigin(side: "left" | "right", rowCenter: number, top: number, height: number) {
  return `${side === "left" ? "100%" : "0%"} ${Math.max(0, Math.min(height, rowCenter - top))}px`;
}

export function QuickViewClosing({ snapshot, onDone }: { snapshot: QuickViewExit; onDone: (id: number) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useLayoutEffect(() => {
    const element = snapshot.element;
    root.current?.append(element);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const towardItem = snapshot.layout.side === "left" ? 10 : -10;
    const animation = element.animate([
      { transform: element.style.transform, opacity: element.style.opacity },
      { transform: `translateX(${towardItem}px)`, opacity: 0 },
    ], { duration: reduced ? 1 : 150, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    void animation.finished.then(() => done.current(snapshot.id)).catch(() => {});
    return () => { animation.cancel(); element.remove(); };
  }, [snapshot]);
  return <div ref={root} aria-hidden="true" className="pointer-events-none absolute inset-0 z-20" />;
}
