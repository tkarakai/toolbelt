import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayAccelerator, parseAccelerator } from "../src/bun/hotkey";

test("accelerators parse to Carbon key codes and modifiers", () => {
	expect(parseAccelerator("Control+Option+Shift+T")).toEqual({ keyCode: 17, modifiers: 0x1000 | 0x800 | 0x200 });
	expect(parseAccelerator("Command+Shift+Space")).toEqual({ keyCode: 49, modifiers: 0x100 | 0x200 });
	expect(parseAccelerator("cmd+k")).toEqual({ keyCode: 40, modifiers: 0x100 });
});

test("rejects shortcuts that would hijack typing or don't exist", () => {
	expect(parseAccelerator("T")).toBeNull();
	expect(parseAccelerator("Shift+T")).toBeNull();
	expect(parseAccelerator("Control+F13")).toBeNull();
	expect(parseAccelerator("Hyper+T")).toBeNull();
});

test("display in macOS modifier order", () => {
	expect(displayAccelerator("Shift+Command+Option+Control+T")).toBe("⌃⌥⇧⌘T");
	expect(displayAccelerator("Command+Space")).toBe("⌘Space");
});

const dir = mkdtempSync(join(tmpdir(), "toolbelt-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("settings: defaults, then what was saved", async () => {
	process.env.TOOLBELT_CONFIG_DIR = dir;
	const { loadSettings, saveSettings, DEFAULTS } = await import("../src/bun/settings");
	expect(loadSettings()).toEqual(DEFAULTS);
	saveSettings({ ...DEFAULTS, shortcut: "Command+Option+K" });
	expect(loadSettings().shortcut).toBe("Command+Option+K");
});
