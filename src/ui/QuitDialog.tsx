// "Quit ToolBelt?" — asked before quitting from ⌘Q or a Quit button. ↵ quits (the Quit button
// has focus), esc or Cancel stays, ⇥ moves between them; ⌘Q again while it's open quits too.
import { useCallback, useState } from "react";
import { Power } from "lucide-react";
import { rpc, useCommand } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyHint } from "@/components/key-hint";

let openQuit: () => void = () => {};
/** Ask to quit (for Quit buttons). */
export const askQuit = () => openQuit();

export function QuitDialog() {
	const [open, setOpen] = useState(false);
	openQuit = () => setOpen(true);
	useCommand(
		useCallback(
			(name: string) => {
				if (name !== "confirmQuit") return;
				if (open) rpc.send.quit({}); // ⌘Q twice
				else setOpen(true);
			},
			[open],
		),
	);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="sm:max-w-sm" showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Quit ToolBelt?</DialogTitle>
					<DialogDescription>The menu bar icon and every tool stop. Processes you started in your terminals keep running.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
						<KeyHint keys="esc" />
					</Button>
					<Button variant="destructive" autoFocus onClick={() => rpc.send.quit({})}>
						<Power />
						Quit
						<KeyHint keys="↵" />
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
