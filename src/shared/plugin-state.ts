// Generic plugin runtime state, independent of native app RPC.
import type { Manifest } from "./protocol";

export type PluginState = "starting" | "running" | "crashed" | "stopped";

export type PluginInfo = {
	manifest: Manifest;
	state: PluginState;
	badge: number | string | null;
	/** Last lines of the plugin's stderr when it crashed. */
	error?: string;
};

