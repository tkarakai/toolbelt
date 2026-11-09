// Keep the menu bar icon highlighted while the popover is open, like a native menu.
//
// Electrobun doesn't expose its NSStatusItem, so this finds our status-bar button through the
// Objective-C runtime (our app's NSStatusBarWindow → its NSStatusBarButton) and calls
// `-highlight:` on the main thread via `performSelectorOnMainThread:` (AppKit isn't
// thread-safe, and Electrobun runs our JavaScript off the main thread). Best effort: if
// anything doesn't look as expected it does nothing.
import { CFunction, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

let ready: null | { button: Pointer; set: (on: boolean) => void } | false = null;

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
		const highlight = sel("highlight:");
		const perform = sel("performSelectorOnMainThread:withObject:waitUntilDone:");
		const b = button;
		return { button: b, set: (on: boolean) => msgPerform(b, perform, highlight, on ? yes : null, false) };
	} catch (e) {
		console.error("tray highlight unavailable:", (e as Error).message);
		return false;
	}
}

export function setTrayHighlighted(on: boolean) {
	if (ready === null) {
		ready = init();
		if (ready) console.log("tray highlight: ready");
	}
	if (ready) ready.set(on);
}
