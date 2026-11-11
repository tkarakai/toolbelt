// A global keyboard shortcut through Carbon's RegisterEventHotKey, called with bun:ffi.
//
// Why not Electrobun's GlobalShortcut: it uses `NSEvent addGlobalMonitorForEvents`, which macOS
// only delivers to apps the person has granted Accessibility access — without it, registration
// "succeeds" and the shortcut silently never fires. Carbon hot keys need no permission (this is
// what Running.app's HotKey.swift does too), and they swallow the keystroke like a menu would.
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

const carbon = dlopen("/System/Library/Frameworks/Carbon.framework/Carbon", {
	GetApplicationEventTarget: { args: [], returns: FFIType.ptr },
	RegisterEventHotKey: { args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
	UnregisterEventHotKey: { args: [FFIType.ptr], returns: FFIType.i32 },
	InstallEventHandler: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
});

// Carbon modifier bits (Events.h).
const MOD = { cmd: 0x100, shift: 0x200, option: 0x800, control: 0x1000 } as const;

// kVK_ANSI_* and friends (HIToolbox/Events.h).
const KEYS: Record<string, number> = {
	A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
	"1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
	"]": 30, O: 31, U: 32, "[": 33, I: 34, P: 35, L: 37, J: 38, "'": 39, K: 40, ";": 41, "\\": 42, ",": 43,
	"/": 44, N: 45, M: 46, ".": 47, "`": 50, SPACE: 49,
};

export type Parsed = { keyCode: number; modifiers: number };

/** "Control+Option+Shift+T" → Carbon key code and modifiers; null if it can't be a shortcut. */
export function parseAccelerator(accel: string): Parsed | null {
	const parts = accel.split("+").map((p) => p.trim()).filter(Boolean);
	const key = parts.pop()?.toUpperCase();
	if (!key || !(key in KEYS)) return null;
	let modifiers = 0;
	for (const p of parts) {
		const m = p.toLowerCase();
		if (m === "command" || m === "cmd" || m === "commandorcontrol") modifiers |= MOD.cmd;
		else if (m === "control" || m === "ctrl") modifiers |= MOD.control;
		else if (m === "option" || m === "alt") modifiers |= MOD.option;
		else if (m === "shift") modifiers |= MOD.shift;
		else return null;
	}
	// A global shortcut needs Command, Control or Option — plain letters would hijack typing.
	if (!(modifiers & (MOD.cmd | MOD.control | MOD.option))) return null;
	return { keyCode: KEYS[key], modifiers };
}

/** "Control+Option+Shift+T" → "⌃⌥⇧T", in macOS order. */
export function displayAccelerator(accel: string): string {
	const parts = accel.split("+").map((p) => p.trim().toLowerCase());
	const key = accel.split("+").pop()!.trim();
	return (
		(parts.includes("control") || parts.includes("ctrl") ? "⌃" : "") +
		(parts.includes("option") || parts.includes("alt") ? "⌥" : "") +
		(parts.includes("shift") ? "⇧" : "") +
		(parts.includes("command") || parts.includes("cmd") ? "⌘" : "") +
		(key.toLowerCase() === "space" ? "Space" : key.toUpperCase())
	);
}

const SIGNATURE = 0x54424c54; // 'TBLT'
let handlerInstalled = false;
let current: { ref: number; action: () => void } | null = null;
// Keep the callback alive for the life of the process.
let callback: JSCallback | null = null;

function installHandler() {
	if (handlerInstalled) return true;
	callback = new JSCallback(
		() => {
			// Only one hot key is registered at a time, so any press is ours.
			queueMicrotask(() => current?.action());
			return 0; // noErr
		},
		{ args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32, threadsafe: true },
	);
	// EventTypeSpec { eventClass: 'keyb', eventKind: kEventHotKeyPressed (5) }
	const spec = new Uint32Array([0x6b657962, 5]);
	const handlerRef = new BigUint64Array(1);
	const status = carbon.symbols.InstallEventHandler(carbon.symbols.GetApplicationEventTarget(), callback.ptr, 1, ptr(spec), null, ptr(handlerRef));
	handlerInstalled = status === 0;
	return handlerInstalled;
}

/**
 * Register `accel` as the global shortcut, replacing the previous one. Returns null on
 * success, or why it failed (unknown key, taken by another app…).
 */
export function setHotKey(accel: string, action: () => void): string | null {
	const parsed = parseAccelerator(accel);
	if (!parsed) return `“${accel}” isn't a shortcut ToolBelt can use (it needs ⌘, ⌃ or ⌥ and a letter, digit or symbol)`;
	if (!installHandler()) return "couldn't install the keyboard event handler";
	clearHotKey();
	const ref = new BigUint64Array(1);
	// EventHotKeyID { signature: OSType, id: UInt32 } passed by value as one 64-bit word.
	const id = BigInt(SIGNATURE) | (1n << 32n);
	const status = carbon.symbols.RegisterEventHotKey(parsed.keyCode, parsed.modifiers, id, carbon.symbols.GetApplicationEventTarget(), 0, ptr(ref));
	if (status !== 0) return status === -9878 ? `${displayAccelerator(accel)} is already used by another app` : `couldn't register ${displayAccelerator(accel)} (${status})`;
	current = { ref: Number(ref[0]), action };
	return null;
}

export function clearHotKey() {
	if (!current) return;
	carbon.symbols.UnregisterEventHotKey(current.ref as never);
	current = null;
}
