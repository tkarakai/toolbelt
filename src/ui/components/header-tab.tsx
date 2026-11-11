import type { ComponentProps, ReactNode } from "react";
import { TabsTrigger } from "./ui/tabs";
import { KeyHint } from "./key-hint";
import { cn } from "@/lib/utils";

/** Shared header tab geometry for plugin screens and Settings. */
export function HeaderTab({label, icon, shortcut, indicator, className, ...props}: ComponentProps<typeof TabsTrigger> & {
    label: string;
    icon?: ReactNode;
    shortcut: string;
    indicator?: ReactNode;
}) {
    return <TabsTrigger {...props} className={cn("flex-none gap-0 px-3 data-[state=active]:bg-selected! data-[state=active]:text-selected-foreground! data-[state=active]:hover:text-selected-foreground!", className)}>
        <span className="inline-flex items-center gap-1.5">{icon}<span className="relative">{label}{indicator && <span className="absolute -right-[7px] -top-1 inline-flex">{indicator}</span>}</span></span>
        <KeyHint className="ml-1.5 shrink-0" keys={shortcut}/>
    </TabsTrigger>;
}
