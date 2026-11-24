// Toolbelt's own settings, in ~/Library/Application Support/Toolbelt/settings.json
// (TOOLBELT_CONFIG_DIR overrides the folder, for tests and trial runs).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REMOTE_DEFAULT_PORT, type RemoteSettings } from "../shared/remote";

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

const dir = () => process.env.TOOLBELT_CONFIG_DIR ?? join(homedir(), "Library/Application Support/Toolbelt");
const file = () => join(dir(), "settings.json");

export function loadSettings(defaults: Settings = DEFAULTS): Settings {
	try {
		const saved = JSON.parse(readFileSync(file(), "utf8"));
		const remote = saved.remote && typeof saved.remote === "object" ? saved.remote : {};
		return { ...defaults, ...saved, remote: { ...defaults.remote, ...remote } };
	} catch {
		return { ...defaults };
	}
}

export function saveSettings(s: Settings) {
	mkdirSync(dir(), { recursive: true });
	writeFileSync(file(), JSON.stringify(s, null, "\t") + "\n");
}
