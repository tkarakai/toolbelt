// Keep the menu bar icon highlighted while the popover is open, like a native menu.
//
// Electrobun doesn't expose its NSStatusItem, so this finds our status-bar button through the
// Objective-C runtime (our app's NSStatusBarWindow → its NSStatusBarButton) and calls
// `-highlight:` on the main thread via `performSelectorOnMainThread:` (AppKit isn't
// thread-safe, and Electrobun runs our JavaScript off the main thread). Best effort: if
// anything doesn't look as expected it does nothing.
import { CFunction, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

type Ready = { button: Pointer; set: (on: boolean) => void; get: () => boolean; setTemplate: (on: boolean) => void; isTemplate: () => boolean; isDark: () => boolean };
let ready: null | Ready | false = null;
let wanted = false;
let timers: ReturnType<typeof setTimeout>[] = [];

function init() {
	try {
		const objc = dlopen("/usr/lib/libobjc.A.dylib", {
			objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
			sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
			object_getClassName: { args: [FFIType.ptr], returns: FFIType.cstring },
			objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		});
		const send = (objc.symbols.objc_msgSend as unknown as { ptr: Pointer }).ptr;
		const msg = objc.symbols.objc_msgSend as (...a: unknown[]) => Pointer | null;
		const msgIndex = CFunction({ ptr: send, args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr });
		const msgCount = CFunction({ ptr: send, args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 });
		const msgPerform = CFunction({ ptr: send, args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.void });
		const sel = (s: string) => objc.symbols.sel_registerName(ptr(Buffer.from(s + "\0")))!;
		const cls = (s: string) => objc.symbols.objc_getClass(ptr(Buffer.from(s + "\0")))!;

		const app = msg(cls("NSApplication"), sel("sharedApplication"));
		const windows = msg(app, sel("windows"));
		if (!app || !windows) return false;
		const n = Number(msgCount(windows, sel("count")));
		let button: Pointer | null = null;
		const tree: string[] = [];
		for (let i = 0; i < n && !button; i++) {
			const w = msgIndex(windows, sel("objectAtIndex:"), i) as Pointer;
			if (String(objc.symbols.object_getClassName(w)) !== "NSStatusBarWindow") continue;
			// The button is the content view, or (macOS 26) inside an NSStatusBarContentView.
			const view = msg(w, sel("contentView"));
			if (!view) continue;
			// Depth-first through the view tree for the status bar button.
			const walk = (v: Pointer, depth: number) => {
				if (button || depth > 4) return;
				const name = String(objc.symbols.object_getClassName(v));
				tree.push(`${"  ".repeat(depth)}${name}`);
				if (name.includes("StatusBarButton")) return void (button = v);
				const subs = msg(v, sel("subviews"));
				const m = subs ? Number(msgCount(subs, sel("count"))) : 0;
				for (let j = 0; j < m; j++) walk(msgIndex(subs, sel("objectAtIndex:"), j) as Pointer, depth + 1);
			};
			walk(view as Pointer, 0);
		}
		if (!button) {
			const seen: string[] = [];
			for (let i = 0; i < n; i++) {
				const w = msgIndex(windows, sel("objectAtIndex:"), i) as Pointer;
				const v = msg(w, sel("contentView"));
				seen.push(`${objc.symbols.object_getClassName(w)}/${v ? objc.symbols.object_getClassName(v) : "-"}`);
			}
			console.error(`tray highlight: status bar button not found among ${seen.join(", ")}; views: ${tree.join(" | ")}`);
			return false;
		}

		// `-highlight:` takes a BOOL, but performSelector passes an object pointer: nil means NO,
		// and any retained object whose address has a non-zero low byte reads as YES.
		const strings: Pointer[] = [];
		let yes: Pointer | null = null;
		for (let i = 0; i < 32 && !yes; i++) {
			const s = msg(msg(cls("NSMutableString"), sel("alloc")), sel("init")) as Pointer; // kept forever
			strings.push(s);
			if ((Number(s) & 0xff) !== 0) yes = s;
		}
		if (!yes) return false;
		const highlight = sel("setHighlighted:");
		const perform = sel("performSelectorOnMainThread:withObject:waitUntilDone:");
		const b = button;
        const text = Buffer.from("ToolBelt\0");
        const makeString = CFunction({ ptr: send, args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr });
        const tooltip = makeString(cls("NSString"), sel("stringWithUTF8String:"), ptr(text));
        msgPerform(b, perform, sel("setToolTip:"), tooltip, true);
		const msgBool = CFunction({ ptr: send, args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool });
		const isHighlighted = sel("isHighlighted");
		const msgText = CFunction({ ptr: send, args: [FFIType.ptr, FFIType.ptr], returns: FFIType.cstring });
		return {
			button: b,
			set: (on: boolean) => msgPerform(b, perform, highlight, on ? yes : null, false),
			get: () => !!msgBool(b, isHighlighted),
			// The image's template flag: a template is drawn in the menu bar's color (no red).
			// Set on the main thread, then the image is handed to the button again to redraw it.
			setTemplate: (on: boolean) => {
				const img = msg(b, sel("image"));
				if (!img) return;
				msgPerform(img as Pointer, perform, sel("setTemplate:"), on ? yes : null, false);
				msgPerform(b, perform, sel("setImage:"), img as Pointer, false);
			},
			isTemplate: () => {
				const img = msg(b, sel("image"));
				return !!img && !!msgBool(img as Pointer, sel("isTemplate"));
			},
			// Whether the menu bar is dark here (it follows the wallpaper, not only Dark Mode).
			isDark: () => {
				const appearance = msg(b, sel("effectiveAppearance"));
				const name = appearance && msg(appearance as Pointer, sel("name"));
				return !!name && String(msgText(name as Pointer, sel("UTF8String"))).includes("Dark");
			},
		};
	} catch (e) {
		console.error("tray highlight unavailable:", (e as Error).message);
		return false;
	}
}

function button(): Ready | null {
	if (ready === null) {
		ready = init();
		if (ready) console.log("tray highlight: ready");
	}
	return ready || null;
}

export function setTrayHighlighted(on: boolean) {
	if (!button() || !ready) return;
	wanted = on;
	timers.forEach(clearTimeout);
	ready.set(on);
	// A click releases the button after its action ran, which clears the highlight again:
	// re-apply it once the click is over.
	if (on) timers = [60, 200, 450].map((ms) => setTimeout(() => wanted && ready && ready.set(true), ms));
}

/** Whether the menu bar icon is highlighted now (debug channel); null if unknown. */
export function trayHighlighted(): boolean | null {
	return ready ? ready.get() : null;
}

/** Make the menu bar icon's current image a template (or not). Best effort. */
export function setTrayTemplate(on: boolean) {
	button()?.setTemplate(on);
}

/** The icon's template flag (debug channel); null if unknown. */
export function trayTemplate(): boolean | null {
	return ready ? ready.isTemplate() : null;
}

/** Whether the menu bar behind the icon is dark; null if unknown. */
export function trayDark(): boolean | null {
	const b = button();
	return b ? b.isDark() : null;
}
