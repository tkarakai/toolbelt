// What kind of device this view runs on (docs/remote-access.md): inside the app, in the local
// browser preview, or on another device through remote access; with or without a keyboard.

/** Inside ToolBelt's own web views. */
export const inApp =
	typeof window !== "undefined" && (window as { __electrobunWebviewId?: number }).__electrobunWebviewId !== undefined;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** Served to another device through remote access (not the app, not the local preview). */
export const remoteClient = typeof location !== "undefined" && !inApp && !LOCAL_HOSTS.includes(location.hostname);

/** The primary pointer is a finger. */
export const touchPrimary =
	typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;

/** Remote and touch devices always get the main window, never the popover. */
export const popoverAllowed = !remoteClient && !touchPrimary;

/** Keys the on-screen keyboard can't produce: they prove a physical keyboard is attached. */
export function physicalKeyboardEvidence(e: {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	editable: boolean;
}) {
	if (e.metaKey || e.ctrlKey) return true;
	if (e.editable) return false;
	return e.altKey || ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "F6"].includes(e.key);
}

/**
 * Hides key hints on touch devices until a physical keyboard shows up
 * (`html[data-keyboard="none"]`, styled in index.css).
 */
export function installKeyboardDetection() {
	if (!touchPrimary) return;
	const root = document.documentElement;
	root.dataset.keyboard = "none";
	const onKey = (e: KeyboardEvent) => {
		const target = e.target as HTMLElement | null;
		const editable = !!target?.closest?.("input, textarea, select, [contenteditable=true], .cm-editor");
		if (!physicalKeyboardEvidence({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, editable })) return;
		delete root.dataset.keyboard;
		window.removeEventListener("keydown", onKey, true);
	};
	window.addEventListener("keydown", onKey, true);
}
