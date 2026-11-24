// The hover (and keyboard-focus) card for an icon control, with its keyboard shortcut if any: what
// activating it will do right now ("Hide details"), and its keys in the usual key hint. Icon controls
// in the window use it instead of a permanent key hint.
import type { ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { KeyHint } from "./key-hint";

export function ShortcutTooltip({ label, detail, keys, side = "bottom", align = "center", children }: {
	label: string;
	/** A second, quieter line ("Updates available"). */
	detail?: string;
	/** Its keys, if it has a shortcut. */
	keys?: string;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	children: ReactNode;
}) {
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					data-slot="shortcut-tooltip"
					side={side}
					align={align}
					sideOffset={6}
					collisionPadding={8}
					className={cn(
						"z-50 flex origin-(--radix-tooltip-content-transform-origin) items-center gap-3 rounded-lg border bg-popover py-1.5 pr-1.5 pl-2.5 text-xs text-popover-foreground shadow-lg",
						"duration-200 ease-out data-[state=closed]:duration-150",
						"data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
						"data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
						"data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
					)}
				>
					<span className="flex min-w-0 flex-col leading-tight">
						<span className="font-medium">{label}</span>
						{detail && <span className="mt-0.5 text-muted-foreground">{detail}</span>}
					</span>
					{keys && <KeyHint keys={keys} className="ml-0" />}
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
