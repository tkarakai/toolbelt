// The keyboard shortcut drawn inside a button ("Cancel esc", "Quit ↵"). It takes the button's
// own text color, so it reads on outline, ghost, filled and destructive buttons alike. It's a
// picture of the keys: screen readers get them from the control's `aria-keyshortcuts` instead
// (see `ariaShortcut`), so the control's name stays "Cancel", not "Cancel esc".
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export function KeyHint({ keys, className }: { keys: string; className?: string }) {
	return <Kbd aria-hidden="true" className={cn("ml-0.5 bg-current/12 text-current", className)}>{keys}</Kbd>;
}
