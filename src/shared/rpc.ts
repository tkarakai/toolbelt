// What the web views (main window, menu bar popover) and the Bun main process say to each other.
import type { RPCSchema } from "electrobun/view";
import type { Manifest, Node } from "./protocol";
import type { UpdateState } from "../bun/updater";

export type { Phase as UpdatePhase, Release, UpdateState } from "../bun/updater";

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
			pluginManager:{params:import("../bun/plugin-manager-service").ManagerRequest;response:Awaited<ReturnType<import("../bun/plugin-manager-service").PluginManagerService["handle"]>>};
			pluginAsset: { params: { reference:string }; response: string|null };
			plugins: { params: {}; response: PluginInfo[] };
            initialNavigation: { params: {}; response: import("./navigation").WindowNavigation | null };
            popoverLayout: { params: { height: number; details: boolean; anchorTop: number; reserveHeight?: number }; response: import("./popover").PopoverLayout };
			/** Start watching a surface; the current tree (if any) comes back right away. */
			open: { params: Surface; response: Node | null };
			close: { params: Surface; response: true };
			event: { params: Surface & { name: string; payload?: unknown }; response: true };
			restartPlugin: { params: { plugin: string }; response: true };
			settings: { params: {}; response: { shortcut: string; shortcutLabel: string; shortcutError: string | null; theme: string; mode: "system" | "light" | "dark" } };
			setAppearance: { params: { theme?: string; mode?: string }; response: true };
			/** Open a link in the default browser (http, https, mailto). */
			openUrl: { params: { url: string }; response: boolean };
			setShortcut: { params: { accelerator: string }; response: { ok: boolean; error?: string; label?: string } };
			pauseShortcut: { params: { paused: boolean }; response: true };
			/** The icon macOS shows for a file or app bundle, as a PNG data URL (null: no such file). */
			fileIcon: { params: { path: string }; response: string | null };
			/** Updates (src/bun/updater.ts): where they stand; changes arrive as `updateState`. */
			updateState: { params: {}; response: UpdateState };
			checkForUpdates: { params: {}; response: true };
			installUpdate: { params: {}; response: true };
			/** Stop the download. */
			cancelUpdate: { params: {}; response: true };
			/** Close a failed update (back to idle). */
			dismissUpdate: { params: {}; response: true };
		};
		messages: {
			/** From the popover: show the main window on this plugin (and screen). */
			showWindow: { plugin?: string; screen?: string; selection?: import("./navigation").NavigationSelection };
			hidePopover: {};
            selectionChanged: { plugin: string; selection: import("./navigation").NavigationSelection | null };
			closeWindow: {};
			zoomWindow: {};
			/** Debug channel: the value of a script the main process evaluated in this view. */
			debugReport: { id: number; value: unknown };
			quit: {};
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			plugins: PluginInfo[];
            selectionChanged: { plugin: string; selection: import("./navigation").NavigationSelection | null };
            pluginManagerState:ReturnType<import("../bun/plugin-manager-service").PluginManagerService["read"]>;
			tree: Surface & { tree: Node };
			toast: { plugin: string; text: string; tone?: "default" | "success" | "error"; action?: { id: string; label: string; payload?: unknown } };
			/** Ask before quitting (⌘Q, Quit buttons): this view shows the confirmation. */
			confirmQuit: {};
			/** Main window: switch to this plugin/screen. */
			navigate: import("./navigation").WindowNavigation;
			/** Popover: it was just shown (reset to the list, focus search). */
			popoverShown: {};
			/** Popover: it's about to be hidden — play the closing animation. */
			popoverHiding: {};
			settingsChanged: {};
			updateState: UpdateState;
			/** From the app menu: a command for the window (toggleSidebar…). */
			command: { name: string };
		};
	}>;
};
