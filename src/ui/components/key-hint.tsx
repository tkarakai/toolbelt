// The keyboard shortcut drawn inside a button ("Cancel esc", "Quit ↵"). It takes the button's
// own text color, so it reads on outline, ghost, filled and destructive buttons alike.
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export function KeyHint({ keys, className }: { keys: string; className?: string }) {
	return <Kbd className={cn("ml-0.5 bg-current/12 text-current", className)}>{keys}</Kbd>;
}
