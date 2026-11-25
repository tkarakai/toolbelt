// Toolbelt's own settings, in ~/Library/Application Support/Toolbelt/settings.json
// (TOOLBELT_CONFIG_DIR overrides the folder, for tests and trial runs).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REMOTE_DEFAULT_PORT, validPort, type RemoteSettings } from "../shared/remote";

export type Settings = {
	/** Global shortcut for the menu bar popover, Electron-style ("Control+Option+Shift+T"). */
	shortcut: string;
	/** Color theme id (src/ui/themes.ts). */
	theme: string;
	mode: "system" | "light" | "dark";
	/** Remote access (docs/remote-access.md). */
	remote: RemoteSettings;
};

export const DEFAULTS: Settings = {
	shortcut: "Control+Option+Shift+T",
	theme: "graphite",
	mode: "system",
	remote: { enabled: false, port: REMOTE_DEFAULT_PORT, badgePlugins: [] },
};

/** ToolBelt's settings folder (TOOLBELT_CONFIG_DIR, or the variant's Application Support). */
export const settingsDir = () => process.env.TOOLBELT_CONFIG_DIR ?? join(homedir(), "Library/Application Support/Toolbelt");
const file = () => join(settingsDir(), "settings.json");

/** Saved remote access settings, each field checked; anything malformed takes its default. */
export function remoteSettings(saved: unknown, defaults: RemoteSettings): RemoteSettings {
	const s = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
	return {
		enabled: typeof s.enabled === "boolean" ? s.enabled : defaults.enabled,
		port: validPort(s.port) ? s.port : defaults.port,
		badgePlugins: Array.isArray(s.badgePlugins)
			? [...new Set(s.badgePlugins.filter((p): p is string => typeof p === "string"))]
			: defaults.badgePlugins,
	};
}

export function loadSettings(defaults: Settings = DEFAULTS): Settings {
	try {
		const saved = JSON.parse(readFileSync(file(), "utf8"));
		return { ...defaults, ...saved, remote: remoteSettings(saved.remote, defaults.remote) };
	} catch {
		return { ...defaults };
	}
}

export function saveSettings(s: Settings) {
	mkdirSync(settingsDir(), { recursive: true });
	writeFileSync(file(), JSON.stringify(s, null, "\t") + "\n");
}
