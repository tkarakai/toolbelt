import { useId, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export function DisclosureIndicator({ open, compact = false }: { open: boolean; compact?: boolean }) {
  return <span aria-hidden="true" className={cn("relative flex shrink-0 items-center justify-center rounded-full border bg-background/60 text-muted-foreground", compact ? "size-4" : "size-5")}>
    <span className="absolute h-px w-2 bg-current"/>
    <span className={cn("absolute h-2 w-px bg-current transition-transform ease-out motion-reduce:transition-none", open ? "scale-y-0 duration-200" : "scale-y-100 duration-150")}/>
  </span>;
}
export function DisclosureContent({ open, id, labelledBy, children }: { open: boolean; id: string; labelledBy: string; children: ReactNode }) {
  return <div id={id} role="region" aria-labelledby={labelledBy} aria-hidden={!open} inert={!open}
    className={cn("grid transition-[grid-template-rows,opacity] ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr] opacity-100 duration-200" : "grid-rows-[0fr] opacity-0 duration-150")}>
    <div className="min-h-0 min-w-0 overflow-hidden">{children}</div>
  </div>;
}

/** Local disclosure state; the mounted grid animates intrinsic height in both directions. */
export function DiagnosticDisclosure({ title, description, icon, badge, metadata, notice = false, compact = false, showAction = true, singleLine = false, children, className, triggerClassName, contentClassName }: {
  title: ReactNode;
  description?: string;
  icon?: ReactNode;
  badge?: ReactNode;
  metadata?: ReactNode;
  notice?: boolean;
  compact?: boolean;
  showAction?: boolean;
  singleLine?: boolean;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className={cn("min-w-0 overflow-hidden rounded-lg border bg-background/60 text-foreground", className)} data-diagnostic-disclosure data-state={open ? "open" : "closed"}>
    <Button type="button" variant="ghost" aria-expanded={open} aria-controls={`${id}-content`} id={`${id}-trigger`} onClick={() => setOpen(!open)}
      className={cn("h-auto w-full min-w-0 justify-between gap-3 rounded-none text-left whitespace-normal active:not-aria-[haspopup]:translate-y-0", compact ? "px-2 py-1.5" : "p-3", notice && "p-4 hover:bg-black/5 hover:text-inherit aria-expanded:bg-transparent aria-expanded:text-inherit dark:hover:bg-white/5 dark:hover:text-inherit", triggerClassName)}>
      <span className="flex min-w-0 items-center gap-2.5">
        {icon && <span className={cn("shrink-0", !notice && "text-muted-foreground")}>{icon}</span>}
        <span className="min-w-0"><span className={cn("flex min-w-0 items-center gap-2", metadata && !singleLine && "flex-wrap")}><span className={cn("font-medium", compact ? "text-[10px]" : "text-xs", !description && !showAction && !notice && "truncate", singleLine && "shrink-0 whitespace-nowrap")}>{title}</span>{badge && <span className="shrink-0 rounded-md border bg-background/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{badge}</span>}{metadata && <span className={cn("text-[10px] font-normal tabular-nums text-muted-foreground", singleLine && "min-w-0 truncate")}>{metadata}</span>}</span>{description && <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{description}</span>}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {!compact && showAction && <span className="text-[10px] font-medium text-muted-foreground">{open ? "Hide" : "Show"}</span>}
        <DisclosureIndicator open={open} compact={compact}/>
      </span>
    </Button>
    <DisclosureContent id={`${id}-content`} labelledBy={`${id}-trigger`} open={open}>
      <div className={cn("min-w-0", compact ? "p-2" : "p-3", notice && "px-[17px] pt-0 pb-4", contentClassName)}>{children}</div>
    </DisclosureContent>
  </div>;
}
