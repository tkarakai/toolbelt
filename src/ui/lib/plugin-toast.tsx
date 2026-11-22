// Plugin toasts in the main window, and the ⌘ shortcut a toast's button can carry (`ui.toast-key`).
import { toast } from "sonner";
import { Kbd } from "@/components/ui/kbd";
import type { ToastAction } from "../../shared/protocol";
import { formatKey, isToastKey } from "../renderer/pure";
import { isTyping } from "./uistate";

type Bound = { key: string; press: () => void };
/** Shortcuts of the toasts showing now, newest last: the newest toast with a key wins. */
const bound: Bound[] = [];
let installed = false;

/**
 * Binds toast shortcuts in this view. Only the main window calls it: it's the one that shows
 * toasts, so the popover never takes ⌘Z for a toast it can't see.
 */
export function installToastKeys() {
	if (installed) return;
	installed = true;
	// Capture, so a toast's shortcut wins over screen shortcuts while the toast shows. Text
	// fields and dialogs keep their own ⌘Z (undo typing) and the like.
	window.addEventListener(
		"keydown",
		(e) => {
			if (e.defaultPrevented || e.isComposing || isTyping(e)) return;
			const hit = [...bound].reverse().find((b) => isToastKey(b.key, e));
			if (!hit) return;
			e.preventDefault();
			e.stopPropagation();
			hit.press();
		},
		true,
	);
}

/** Shows a plugin's toast; `send` delivers its button's event. */
export function showPluginToast(
	name: string,
	text: string,
	tone: "default" | "success" | "error" | undefined,
	action: ToastAction | undefined,
	send: (action: ToastAction) => void,
) {
	const show = tone === "error" ? toast.error : tone === "success" ? toast.success : toast;
	if (!action) return show(text, { description: name });
	const key = installed ? action.key : undefined;
	let entry: Bound | undefined;
	const unbind = () => {
		const i = entry ? bound.indexOf(entry) : -1;
		if (i >= 0) bound.splice(i, 1);
	};
	const id = show(text, {
		description: name,
		duration: 8000,
		action: {
			label: key ? (
				<span className="inline-flex items-center gap-1.5">
					{action.label}
					<Kbd className="h-4 bg-background/20 text-current">{formatKey(key)}</Kbd>
				</span>
			) : (
				action.label
			),
			onClick: () => {
				unbind();
				send(action);
			},
		},
		onDismiss: unbind,
		onAutoClose: unbind,
	});
	if (key) {
		entry = {
			key,
			press: () => {
				unbind();
				toast.dismiss(id);
				send(action);
			},
		};
		bound.push(entry);
	}
	return id;
}
