import { flushSync } from "react-dom";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { setPluginOrder } from "./plugin-order";

/** Pointer-driven sorting keeps native clicks until the pointer passes a small threshold.
 * Rows retain their DOM positions until drop; transforms animate the insertion gap. */
export function usePluginDrag(ids: string[]) {
  const ref = useRef<HTMLElement | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => { cancel.current?.(); }, [ids.join("\n")]);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const root = ref.current;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-plugin-sort]");
    if (!root || !target) return;
    cancel.current?.();
    const rows = [...root.querySelectorAll<HTMLElement>("[data-plugin-sort]")];
    const from = rows.indexOf(target);
    if (from < 0) return;
    let scroller = root;
    while (scroller.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const start = event.clientY;
    const startX = event.clientX;
    const scrollStart = scroller.scrollTop;
    // Transformed rows can enlarge scrollHeight. Never auto-scroll into that visual overflow.
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const horizontalBounds = scroller.getBoundingClientRect();
    let angle = 0, angularVelocity = 0, horizontalVelocity = 0;
    let lastFrame = 0, previousX = startX;
    const rects = rows.map(row => row.getBoundingClientRect());
    let x = startX, y = start, to = from, dragging = false, frame = 0;
    const button = target.querySelector("button");
    const originalButtonBackground = button?.style.backgroundColor ?? "";
    const originalButtonColor = button?.style.color ?? "";
    const originalRadius = target.style.borderRadius;
    const originalOverflow = target.style.overflow;
    const originalOrigin = target.style.transformOrigin;
    const gripY = Math.max(0, Math.min(rects[from]!.height, start - rects[from]!.top));
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = () => {
      const delta = Math.max(rects[0]!.top - rects[from]!.top, Math.min(
        rects[rects.length - 1]!.top - rects[from]!.top,
        y - start + scroller.scrollTop - scrollStart,
      ));
      const center = rects[from]!.top + rects[from]!.height / 2 + delta;
      to = from;
      rects.forEach((rect, i) => { if (i < from && center <= rect.top + rect.height / 2) to = Math.min(to, i); if (i > from && center >= rect.top + rect.height / 2) to = Math.max(to, i); });
      rows.forEach((row, i) => {
        const shift = i === from ? delta : from < to && i > from && i <= to ? rects[i - 1]!.top - rects[i]!.top : to < from && i >= to && i < from ? rects[i + 1]!.top - rects[i]!.top : 0;
        row.style.transform = `translateY(${shift}px)`;
      });
      // Rotate around the contact point, leaving the unsupported side hanging lower.
      const gripX = Math.max(0, Math.min(rects[from]!.width, x - rects[from]!.left));
      target.style.transformOrigin = `${gripX}px ${gripY}px`;
      target.style.rotate = `${reduced ? 0 : angle}deg`;
    };
    const tick = (now: number) => {
      const dt = Math.min(1 / 30, Math.max(0, (now - lastFrame) / 1000));
      lastFrame = now;
      if (!reduced && dt > 0) {
        // A damped angular spring gives pickup some weight and lets sideways motion
        // briefly pull the row out of balance before gravity draws it back.
        horizontalVelocity += ((x - previousX) / dt - horizontalVelocity) * (1 - Math.exp(-12 * dt));
        const balance = Math.max(-1, Math.min(1, (x - horizontalBounds.left) / Math.max(1, horizontalBounds.width) * 2 - 1));
        const restingAngle = -balance * 6 + Math.max(-3, Math.min(3, horizontalVelocity * 0.008));
        const steps = Math.max(1, Math.ceil(dt * 120));
        const step = dt / steps;
        for (let i = 0; i < steps; i++) {
          angularVelocity += ((restingAngle - angle) * 180 - angularVelocity * 20) * step;
          angle += angularVelocity * step;
        }
        previousX = x;
      }
      const bounds = scroller.getBoundingClientRect();
      if (y < bounds.top + 24) scroller.scrollTop = Math.max(0, scroller.scrollTop - 6);
      else if (y > bounds.bottom - 24) scroller.scrollTop = Math.min(maxScroll, scroller.scrollTop + 6);
      paint();
      frame = requestAnimationFrame(tick);
    };

    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      x = e.clientX;
      y = e.clientY;
      if (!dragging && Math.hypot(x - startX, y - start) < 5) return;
      e.preventDefault();
      if (!dragging) {
        dragging = true;
        target.dataset.pluginDragging = "true";
        lastFrame = performance.now();
        suppressClick.current = true;
        target.setPointerCapture(event.pointerId);
        rows.forEach(row => { row.style.transition = reduced ? "none" : "transform 200ms ease-out"; row.style.position = "relative"; });
        // The sidebar sorts the outer <li>, while its button owns the rounded shape.
        // Give the lifted surface the same silhouette and clip child hover backgrounds.
        target.style.borderRadius = getComputedStyle(target.querySelector("button") ?? target).borderRadius;
        target.style.overflow = "hidden";
        if (button) { button.style.backgroundColor = "transparent"; button.style.color = "inherit"; }
        target.style.transition = reduced ? "none" : "scale 200ms ease-out, box-shadow 200ms ease-out";
        // Individual transforms let pickup animate while translation follows the pointer.
        target.style.scale = "1.025";
        target.style.zIndex = "10";
        target.style.boxShadow = "0 5px 14px #0003";
        target.style.backgroundColor = "var(--selected)";
        target.style.color = "var(--selected-foreground)";
        frame = requestAnimationFrame(tick);
      }
      paint();
    };
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame);
      delete target.dataset.pluginDragging;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("keydown", key, true);
      target.removeEventListener("lostpointercapture", abort);
      window.removeEventListener("blur", abort);
      cancel.current = null;
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      const origin = target.style.transformOrigin;
      const rotation = getComputedStyle(target).rotate;
      const scale = getComputedStyle(target).scale;
      target.style.transition = "none";
      target.style.rotate = "";
      target.style.scale = "";
      const positions = rows.map(row => row.getBoundingClientRect().top);
      rows.forEach(row => { row.style.transform = ""; row.style.transition = ""; row.style.position = ""; });
      if (button) { button.style.backgroundColor = originalButtonBackground; button.style.color = originalButtonColor; }
      target.style.transformOrigin = originalOrigin;
      target.style.borderRadius = originalRadius;
      target.style.overflow = originalOverflow;
      target.style.zIndex = ""; target.style.boxShadow = ""; target.style.backgroundColor = ""; target.style.color = "";
      if (dragging && commit && from !== to) {
        const next = [...ids]; next.splice(to, 0, next.splice(from, 1)[0]!);
        flushSync(() => setPluginOrder(next));
      }
      if (dragging && !reduced) rows.forEach((row, i) => {
        const offset = positions[i]! - row.getBoundingClientRect().top;
        if (offset || row === target) row.animate([
          { transform: `translateY(${offset}px)`, rotate: row === target ? rotation : "0deg", scale: row === target ? scale : "1", boxShadow: row === target ? "0 5px 14px #0003" : "none", transformOrigin: row === target ? origin : getComputedStyle(row).transformOrigin },
          { transform: "translateY(0)", rotate: "0deg", scale: "1", boxShadow: "none", transformOrigin: row === target ? origin : getComputedStyle(row).transformOrigin },
        ], { duration: 200, easing: "ease-out" });
      });
      // The synthetic click follows pointerup synchronously.
      setTimeout(() => { suppressClick.current = false; }, 0);
    };
    const up = (e: PointerEvent) => { if (e.pointerId === event.pointerId) finish(true); };
    const abort = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); abort(); } };
    cancel.current = abort;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("keydown", key, true);
    target.addEventListener("lostpointercapture", abort);
    window.addEventListener("blur", abort);
  };
  return {
    ref: (element: HTMLElement | null) => { ref.current = element; },
    onPointerDown,
    onClickCapture: (event: React.MouseEvent) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } },
  };
}
