// Focus rings appear only for keyboard use. Opening a window, the popover, a dialog or a quick
// view focuses something programmatically, and WebKit and Chrome may then match :focus-visible
// although nobody used the keyboard. `html[data-input-modality]` records how the person last
// interacted: "keyboard" after a key press, "pointer" after a click or tap, "none" when the view
// was just shown. index.css hides focus indicators unless it is "keyboard"; text fields keep
// theirs, since typing needs to show where the caret is.

export type InputModality = "none" | "pointer" | "keyboard";

const MODIFIERS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "OS"]);

/** The modality a key press means: holding a modifier alone (⌘ for number hints) changes nothing. */
export const modalityForKey = (key: string): InputModality | null => (MODIFIERS.has(key) ? null : "keyboard");

const set = (modality: InputModality) => {
	if (document.documentElement.dataset.inputModality !== modality) document.documentElement.dataset.inputModality = modality;
};

/** Back to "none": the view was just shown (popover opened, window focused from elsewhere). */
export const resetInputModality = () => set("none");

export function installInputModality() {
	set("none");
	window.addEventListener(
		"keydown",
		(e) => {
			const modality = modalityForKey(e.key);
			if (modality) set(modality);
		},
		true,
	);
	window.addEventListener("pointerdown", () => set("pointer"), true);
	// Arriving from another app (⌘-Tab, the global shortcut) is not keyboard use inside the view.
	window.addEventListener("focus", resetInputModality);
}
