import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ComponentProps, type PointerEvent } from "react";
import { DialogContent, DialogHeader } from "./dialog";
import { cn } from "@/lib/utils";

type Size = {w: number; h: number};
const fit = ({w,h}: Size): Size => ({
    w: Math.max(Math.min(384, innerWidth - 32), Math.min(innerWidth - 32, w)),
    h: Math.max(Math.min(280, innerHeight - 32), Math.min(innerHeight - 32, h)),
});

/** Movable, viewport-bounded dialog with edge/corner grips and keyboard resizing. */
export function ResizableDialogContent({children, className, style, ...props}: ComponentProps<typeof DialogContent>) {
    const box = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState(() => fit({w:640,h:640}));
    const [offset, setOffset] = useState({x:0,y:0});
    const moving = useRef<{x:number;y:number;left:number;top:number} | null>(null);
    const drag = useRef<{x:number;y:number;w:number;h:number;dx:number;dy:number;left:number;top:number} | null>(null);
    useEffect(() => {
        const resize = () => {setSize(current => fit(current)); setOffset({x:0,y:0});};
        window.addEventListener("resize",resize);
        return () => window.removeEventListener("resize",resize);
    },[]);
    const begin = (dx:number,dy:number) => (event:PointerEvent<HTMLElement>) => {
        if (event.button !== 0 || !box.current) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = box.current.getBoundingClientRect();
        drag.current = {x:event.clientX,y:event.clientY,w:rect.width,h:rect.height,dx,dy,left:rect.left,top:rect.top};
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const move = (event:PointerEvent<HTMLElement>) => {
        const start = drag.current;
        if (!start) return;
        const right = start.left + start.w, bottom = start.top + start.h;
        const minW = Math.min(384, innerWidth-32), minH = Math.min(280, innerHeight-32);
        const left = start.dx < 0 ? Math.max(16, Math.min(right-minW, start.left+event.clientX-start.x)) : start.left;
        const top = start.dy < 0 ? Math.max(16, Math.min(bottom-minH, start.top+event.clientY-start.y)) : start.top;
        const nextRight = start.dx > 0 ? Math.min(innerWidth-16, Math.max(left+minW, right+event.clientX-start.x)) : right;
        const nextBottom = start.dy > 0 ? Math.min(innerHeight-16, Math.max(top+minH, bottom+event.clientY-start.y)) : bottom;
        setSize({w:nextRight-left,h:nextBottom-top});
        setOffset({x:(left+nextRight-innerWidth)/2,y:(top+nextBottom-innerHeight)/2});
    };
    const end = () => {drag.current=null;};
    const events = {onPointerMove:move,onPointerUp:end,onPointerCancel:end,onLostPointerCapture:end};
    const edges = [
        [1,0,"inset-y-3 -right-1 w-2 cursor-ew-resize"],[-1,0,"inset-y-3 -left-1 w-2 cursor-ew-resize"],
        [0,1,"inset-x-3 -bottom-1 h-2 cursor-ns-resize"],[0,-1,"inset-x-3 -top-1 h-2 cursor-ns-resize"],
        [-1,1,"-bottom-1 -left-1 size-3 cursor-nesw-resize"],[1,-1,"-top-1 -right-1 size-3 cursor-nesw-resize"],
        [-1,-1,"-top-1 -left-1 size-3 cursor-nwse-resize"],
    ] as const;
    return <DialogContent {...props} ref={box} className={cn("flex max-w-none! flex-col transition-none [&_[data-slot=dialog-header]]:cursor-move [&_[data-slot=dialog-header]]:touch-none",className)} style={{...style,left:`calc(50% + ${offset.x}px)`,top:`calc(50% + ${offset.y}px)`,width:size.w,height:size.h,maxWidth:"calc(100vw - 2rem)",maxHeight:"calc(100vh - 2rem)"}} onPointerDown={event => {
            const target = event.target as HTMLElement;
            if (!target.closest('[data-slot="dialog-header"]') || target.closest('button, a, input, select, textarea, [role="button"]')) return;
            if (event.button !== 0) return;
            event.preventDefault();
            moving.current = {x:event.clientX,y:event.clientY,left:offset.x,top:offset.y};
            event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
            const start = moving.current;
            if (!start) return;
            setOffset({x:Math.max(-(innerWidth-size.w)/2+16,Math.min((innerWidth-size.w)/2-16,start.left+event.clientX-start.x)),y:Math.max(-(innerHeight-size.h)/2+16,Math.min((innerHeight-size.h)/2-16,start.top+event.clientY-start.y))});
        }} onPointerUp={() => {moving.current=null;}} onPointerCancel={() => {moving.current=null;}} onLostPointerCapture={() => {moving.current=null;}} onKeyDown={event => {
            if (!(event.target as HTMLElement).matches('[data-slot="dialog-header"]')) return;
            const delta = {ArrowRight:[20,0],ArrowLeft:[-20,0],ArrowDown:[0,20],ArrowUp:[0,-20]}[event.key];
            if (!delta) return;
            event.preventDefault(); event.stopPropagation();
            setOffset(current => ({x:Math.max(-(innerWidth-size.w)/2+16,Math.min((innerWidth-size.w)/2-16,current.x+delta[0]!)),y:Math.max(-(innerHeight-size.h)/2+16,Math.min((innerHeight-size.h)/2-16,current.y+delta[1]!))}));
        }}>
        {Children.map(children, child => isValidElement<ComponentProps<typeof DialogHeader>>(child) && child.type === DialogHeader
            ? cloneElement(child, {tabIndex: 0, "aria-label": "Move dialog using arrow keys"}) : child)}
        {edges.map(([dx,dy,classes]) => <div key={`${dx},${dy}`} aria-hidden="true" className={cn("absolute z-20 touch-none",classes)} onPointerDown={begin(dx,dy)} {...events}/>)}
        <button type="button" aria-label="Resize dialog" title="Drag to resize, or use arrow keys" className="absolute bottom-0.5 right-0.5 z-20 flex size-5 touch-none cursor-nwse-resize items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring" onPointerDown={begin(1,1)} {...events} onKeyDown={event => {
            const amount = event.shiftKey ? 80 : 20;
            const delta = {ArrowRight:[amount,0],ArrowLeft:[-amount,0],ArrowDown:[0,amount],ArrowUp:[0,-amount]}[event.key];
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            const next = fit({w:Math.min(size.w+delta[0]!, (innerWidth+size.w)/2-offset.x-16),h:Math.min(size.h+delta[1]!, (innerHeight+size.h)/2-offset.y-16)});
            setSize(next);
            setOffset(current => ({x:current.x+(next.w-size.w)/2,y:current.y+(next.h-size.h)/2}));
        }}/>
    </DialogContent>;
}
