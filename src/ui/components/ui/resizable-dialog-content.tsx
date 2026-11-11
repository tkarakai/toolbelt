import { useEffect, useRef, useState, type ComponentProps, type PointerEvent } from "react";
import { MoveDiagonal2 } from "lucide-react";
import { DialogContent } from "./dialog";
import { cn } from "@/lib/utils";

type Size = {w: number; h: number};
const fit = ({w,h}: Size): Size => ({
    w: Math.max(Math.min(384, innerWidth - 32), Math.min(innerWidth - 32, w)),
    h: Math.max(Math.min(280, innerHeight - 32), Math.min(innerHeight - 32, h)),
});

/** Centered, viewport-bounded dialog with edge/corner grips and keyboard resizing. */
export function ResizableDialogContent({children, className, style, ...props}: ComponentProps<typeof DialogContent>) {
    const box = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState(() => fit({w:640,h:640}));
    const [offset, setOffset] = useState({x:0,y:0});
    const moving = useRef<{x:number;y:number;left:number;top:number} | null>(null);
    const drag = useRef<{x:number;y:number;w:number;h:number;dx:number;dy:number} | null>(null);
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
        drag.current = {x:event.clientX,y:event.clientY,w:rect.width,h:rect.height,dx,dy};
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const move = (event:PointerEvent<HTMLElement>) => {
        const start = drag.current;
        if (!start) return;
        // Both sides move because the dialog remains centered.
        setOffset({x:0,y:0});
        setSize(fit({w:start.w + 2*start.dx*(event.clientX-start.x),h:start.h + 2*start.dy*(event.clientY-start.y)}));
    };
    const end = () => {drag.current=null;};
    const events = {onPointerMove:move,onPointerUp:end,onPointerCancel:end,onLostPointerCapture:end};
    const edges = [
        [1,0,"inset-y-3 -right-1 w-2 cursor-ew-resize"],[-1,0,"inset-y-3 -left-1 w-2 cursor-ew-resize"],
        [0,1,"inset-x-3 -bottom-1 h-2 cursor-ns-resize"],[0,-1,"inset-x-3 -top-1 h-2 cursor-ns-resize"],
        [-1,1,"-bottom-1 -left-1 size-3 cursor-nesw-resize"],[1,-1,"-top-1 -right-1 size-3 cursor-nesw-resize"],
        [-1,-1,"-top-1 -left-1 size-3 cursor-nwse-resize"],
    ] as const;
    return <DialogContent {...props} ref={box} className={cn("flex max-w-none! flex-col transition-none",className)} style={{...style,left:`calc(50% + ${offset.x}px)`,top:`calc(50% + ${offset.y}px)`,width:size.w,height:size.h,maxWidth:"calc(100vw - 2rem)",maxHeight:"calc(100vh - 2rem)"}}>
        <button type="button" aria-label="Move dialog" title="Drag to move, or use arrow keys" className="-mx-2 -mt-2 h-4 shrink-0 touch-none cursor-move rounded hover:bg-accent focus-visible:outline-ring" onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            moving.current = {x:event.clientX,y:event.clientY,left:offset.x,top:offset.y};
            event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
            const start = moving.current;
            if (!start) return;
            setOffset({x:Math.max(-(innerWidth-size.w)/2+16,Math.min((innerWidth-size.w)/2-16,start.left+event.clientX-start.x)),y:Math.max(-(innerHeight-size.h)/2+16,Math.min((innerHeight-size.h)/2-16,start.top+event.clientY-start.y))});
        }} onPointerUp={() => {moving.current=null;}} onPointerCancel={() => {moving.current=null;}} onLostPointerCapture={() => {moving.current=null;}} onKeyDown={event => {
            const delta = {ArrowRight:[20,0],ArrowLeft:[-20,0],ArrowDown:[0,20],ArrowUp:[0,-20]}[event.key];
            if (!delta) return;
            event.preventDefault(); event.stopPropagation();
            setOffset(current => ({x:Math.max(-(innerWidth-size.w)/2+16,Math.min((innerWidth-size.w)/2-16,current.x+delta[0]!)),y:Math.max(-(innerHeight-size.h)/2+16,Math.min((innerHeight-size.h)/2-16,current.y+delta[1]!))}));
        }}><span className="mx-auto block h-1 w-10 rounded-full bg-muted-foreground/40"/></button>
        {children}
        {edges.map(([dx,dy,classes]) => <div key={`${dx},${dy}`} aria-hidden="true" className={cn("absolute z-20 touch-none",classes)} onPointerDown={begin(dx,dy)} {...events}/>)}
        <button type="button" aria-label="Resize dialog" title="Drag to resize, or use arrow keys" className="absolute bottom-0.5 right-0.5 z-20 flex size-5 touch-none cursor-nwse-resize items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring" onPointerDown={begin(1,1)} {...events} onKeyDown={event => {
            const amount = event.shiftKey ? 80 : 20;
            const delta = {ArrowRight:[amount,0],ArrowLeft:[-amount,0],ArrowDown:[0,amount],ArrowUp:[0,-amount]}[event.key];
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            setSize(current => fit({w:current.w+delta[0]!,h:current.h+delta[1]!}));
        }}><MoveDiagonal2 className="size-3"/></button>
    </DialogContent>;
}
