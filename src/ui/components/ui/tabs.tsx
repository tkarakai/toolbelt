import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex min-w-0 max-w-full gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({left: false, right: false});
  React.useLayoutEffect(() => {
    const viewport = ref.current!;
    const update = () => setEdges({left: viewport.scrollLeft > 1, right: viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1});
    const reveal = () => {
      const active = viewport.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (active) {
        const v = viewport.getBoundingClientRect(), a = active.getBoundingClientRect();
        if (a.left < v.left + 24) viewport.scrollLeft -= v.left + 24 - a.left;
        else if (a.right > v.right - 24) viewport.scrollLeft += a.right - v.right + 24;
      }
      update();
    };
    const resize = new ResizeObserver(reveal);
    resize.observe(viewport);
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
    const mutation = new MutationObserver(reveal);
    mutation.observe(viewport, {subtree: true, attributes: true, attributeFilter: ["data-state"], childList: true});
    viewport.addEventListener("scroll", update, {passive: true});
    reveal();
    return () => { resize.disconnect(); mutation.disconnect(); viewport.removeEventListener("scroll", update); };
  }, []);
  const scroll = (direction: number) => ref.current?.scrollBy({left: direction * Math.max(100, ref.current.clientWidth * .7), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
  return <div className={cn("relative isolate min-w-0 max-w-full overflow-hidden rounded-lg", variant === "default" && "bg-muted")}>
    <div ref={ref} className="tab-viewport overflow-x-auto overflow-y-hidden overscroll-none group-data-horizontal/tabs:h-8" onWheel={e => {
      const v = e.currentTarget;
      if (v.scrollWidth <= v.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.ctrlKey) return;
      if ((e.deltaY > 0 && v.scrollLeft + v.clientWidth < v.scrollWidth - 1) || (e.deltaY < 0 && v.scrollLeft > 0)) { v.scrollLeft += e.deltaY; e.preventDefault(); }
    }}>
      <TabsPrimitive.List data-slot="tabs-list" data-variant={variant} className={cn(tabsListVariants({ variant }), className)} {...props} />
    </div>
    {edges.left && <button type="button" tabIndex={-1} aria-label="Scroll tabs left" onClick={() => scroll(-1)} className="absolute inset-y-0 left-0 flex w-6 items-center justify-center bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronLeft className="size-3.5" /></button>}
    {edges.right && <button type="button" tabIndex={-1} aria-label="Scroll tabs right" onClick={() => scroll(1)} className="absolute inset-y-0 right-0 flex w-6 items-center justify-center bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronRight className="size-3.5" /></button>}
  </div>;

}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-0 group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
