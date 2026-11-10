// Window focus alone needn't update macOS's application activation/MRU ordering. Register
// our process as frontmost before a plugin hands focus to another application. Carbon's
// process activation works without Accessibility permission, like our global hotkeys.
import { dlopen, FFIType, ptr } from "bun:ffi";
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
