// What the web views (main window, menu bar popover) and the Bun main process say to each other.
import type { RPCSchema } from "electrobun/view";
import type { Manifest, Node } from "./protocol";

export type PluginState = "starting" | "running" | "crashed" | "stopped";

export type PluginInfo = {
	manifest: Manifest;
	state: PluginState;
	badge: number | string | null;
	/** Last lines of the plugin's stderr when it crashed. */
	error?: string;
};

export type Surface = { plugin: string; surface: string };

export type ToolbeltRPC = {
	bun: RPCSchema<{
		requests: {
			plugins: { params: {}; response: PluginInfo[] };
			/** Start watching a surface; the current tree (if any) comes back right away. */
			open: { params: Surface; response: Node | null };
			close: { params: Surface; response: true };
			event: { params: Surface & { name: string; payload?: unknown }; response: true };
			restartPlugin: { params: { plugin: string }; response: true };
			/** Open a link in the default browser (http, https, mailto). */
			openUrl: { params: { url: string }; response: boolean };
			settings: { params: {}; response: { shortcut: string; shortcutLabel: string; shortcutError: string | null } };
			setShortcut: { params: { accelerator: string }; response: { ok: boolean; error?: string; label?: string } };
			pauseShortcut: { params: { paused: boolean }; response: true };
		};
		messages: {
			/** From the popover: show the main window on this plugin (and screen). */
			showWindow: { plugin?: string; screen?: string };
			hidePopover: {};
			closeWindow: {};
			/** Debug channel: the value of a script the main process evaluated in this view. */
			debugReport: { id: number; value: unknown };
			quit: {};
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			plugins: PluginInfo[];
			tree: Surface & { tree: Node };
			toast: { plugin: string; text: string; tone?: "default" | "success" | "error" };
			/** Main window: switch to this plugin/screen. */
			navigate: { plugin: string; screen?: string };
			/** Popover: it was just shown (reset to the list, focus search). */
			popoverShown: {};
			settingsChanged: {};
		};
	}>;
};
