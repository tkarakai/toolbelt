// Window focus alone needn't update macOS's application activation/MRU ordering. Register
// our process as frontmost before a plugin hands focus to another application. Carbon's
// process activation works without Accessibility permission, like our global hotkeys.
import { CFunction, dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
let activate: (() => void) | undefined;
export function prepareAppHandoff() {
    try {
        if (!activate) {
            const carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", {
                GetCurrentProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
                SetFrontProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
            });
            const serial = new Uint32Array(2);
            if (carbon.symbols.GetCurrentProcess(ptr(serial)) !== 0) return;
            activate = () => { const status = carbon.symbols.SetFrontProcess(ptr(serial)); if (status !== 0) throw new Error(`SetFrontProcess failed (${status})`); };
        }
        activate();
    } catch (error) { console.error("application activation:", error); }
}

// Capture before activating the tray window. Carbon PSNs remain valid while the app runs.
const openPopoverCarbon = () => dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", {
    GetFrontProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
    SetFrontProcess: { args: [FFIType.ptr], returns: FFIType.i32 },
});
let popoverCarbon: ReturnType<typeof openPopoverCarbon> | undefined;
export function captureFrontApplication(): (() => void) | undefined {
    try {
        const carbon = popoverCarbon ??= openPopoverCarbon();
        const front = new Uint32Array(2), own = new Uint32Array(2);
        if (carbon.symbols.GetFrontProcess(ptr(front)) !== 0 || carbon.symbols.GetCurrentProcess(ptr(own)) !== 0) { return; }
        if (front[0] === own[0] && front[1] === own[1]) { return; }
        // No user resources are changed: restore only the application that opened the popover.
        return () => { carbon.symbols.SetFrontProcess(ptr(front)); };
    } catch (error) { console.error("popover focus capture:", error); return; }
}


// Electrobun's BrowserView pointer is an AbstractView, not the native WKWebView.
// Find the WKWebView inside the target NSWindow instead; only pass actual NSViews
// to AppKit, and perform the responder change synchronously on its main thread.
const openFocusRuntime = () => dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: {args: [FFIType.cstring], returns: FFIType.ptr},
    sel_registerName: {args: [FFIType.cstring], returns: FFIType.ptr},
    objc_msgSend: {args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr},
});
let focusRuntime: ReturnType<typeof openFocusRuntime> | undefined;
export function focusWindowContent(window: Pointer | null) {
    if (!window) return;
    try {
        const objc = focusRuntime ??= openFocusRuntime();
        const sel = (name: string) => objc.symbols.sel_registerName(ptr(Buffer.from(name + "\0")));
        const cls = (name: string) => objc.symbols.objc_getClass(ptr(Buffer.from(name + "\0")));
        const send = (objc.symbols.objc_msgSend as unknown as {ptr: Pointer}).ptr;
        const msg = objc.symbols.objc_msgSend;
        const kind = CFunction({ptr:send, args:[FFIType.ptr,FFIType.ptr,FFIType.ptr], returns:FFIType.bool});
        const count = CFunction({ptr:send, args:[FFIType.ptr,FFIType.ptr], returns:FFIType.u64});
        const at = CFunction({ptr:send, args:[FFIType.ptr,FFIType.ptr,FFIType.u64], returns:FFIType.ptr});
        if (!kind(window,sel("isKindOfClass:"),cls("NSWindow"))) return;
        const webClass = cls("WKWebView");
        if (!webClass) return;
        const find = (view: Pointer | null, depth = 0): Pointer | null => {
            if (!view || depth > 6) return null;
            if (kind(view,sel("isKindOfClass:"),webClass)) return view;
            const children = msg(view,sel("subviews"));
            const length = children ? Number(count(children,sel("count"))) : 0;
            for (let i=0;i<length;i++) {
                const match = find(at(children,sel("objectAtIndex:"),i) as Pointer | null,depth+1);
                if (match) return match;
            }
            return null;
        };
        const view = find(msg(window,sel("contentView")) as Pointer | null);
        if (!view || msg(view,sel("window")) !== window) return;
        const perform = CFunction({ptr:send,args:[FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.ptr,FFIType.bool],returns:FFIType.void});
        perform(window,sel("performSelectorOnMainThread:withObject:waitUntilDone:"),sel("makeFirstResponder:"),view,true);
    } catch (error) { console.error("window keyboard focus:",error); }
}
