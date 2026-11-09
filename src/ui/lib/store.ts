// The web side of Toolbelt: one RPC connection to the main process, and a tiny store of what
// it sent (plugins, UI trees) that React reads with useSyncExternalStore.
import { Electroview } from "electrobun/view";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { Node } from "../../shared/protocol";
import type { PluginInfo, ToolbeltRPC } from "../../shared/rpc";

type State = { plugins: PluginInfo[]; trees: Record<string, Node> };
let state: State = { plugins: [], trees: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
	state = { ...state, ...next };
	listeners.forEach((l) => l());
};
const key = (plugin: string, surface: string) => `${plugin}\n${surface}`;

// Render timing: when each surface's latest tree arrived, and how long until React committed it
// (window.__tbPerf, newest last). Read by the debug channel.
const arrived = new Map<string, number>();
const perf: { surface: string; ms: number }[] = [];
(window as { __tbPerf?: unknown }).__tbPerf = perf;
export function committed(plugin: string, surface: string) {
	const t = arrived.get(key(plugin, surface));
	if (t === undefined) return;
	arrived.delete(key(plugin, surface));
	perf.push({ surface: `${plugin}/${surface}`, ms: performance.now() - t });
	if (perf.length > 300) perf.shift();
}

type NavListener = (plugin: string, screen?: string) => void;
const navListeners = new Set<NavListener>();
const shownListeners = new Set<() => void>();
const settingsListeners = new Set<() => void>();
const commandListeners = new Set<(name: string) => void>();

/** App-menu commands sent to this window (toggleSidebar…). */
export function useCommand(fn: (name: string) => void) {
	useEffect(() => {
		commandListeners.add(fn);
		return () => void commandListeners.delete(fn);
	}, [fn]);
}

const handlers: { [K in keyof Messages]: (p: Messages[K]) => void } = {
	plugins: (plugins) => set({ plugins }),
	tree: ({ plugin, surface, tree }) => {
		arrived.set(key(plugin, surface), performance.now());
		set({ trees: { ...state.trees, [key(plugin, surface)]: tree } });
	},
	toast: ({ plugin, text, tone, action }) => {
		const name = state.plugins.find((p) => p.manifest.id === plugin)?.manifest.name ?? plugin;
		(tone === "error" ? toast.error : tone === "success" ? toast.success : toast)(text, {
			description: name,
			...(action ? { action: { label: action.label, onClick: () => sendEvent(plugin, "toast", action.id, action.payload) }, duration: 8000 } : {}),
		});
	},
	navigate: ({ plugin, screen }) => navListeners.forEach((l) => l(plugin, screen)),
	popoverShown: () => shownListeners.forEach((l) => l()),
	settingsChanged: () => settingsListeners.forEach((l) => l()),
	command: ({ name }) => commandListeners.forEach((l) => l(name)),
	confirmQuit: () => commandListeners.forEach((l) => l("confirmQuit")),
};

type Messages = ToolbeltRPC["webview"]["messages"];
type Requests = ToolbeltRPC["bun"]["requests"];
type BunMessages = ToolbeltRPC["bun"]["messages"];
export type Transport = {
	request: { [K in keyof Requests]: (p: Requests[K]["params"]) => Promise<Requests[K]["response"]> };
	send: { [K in keyof BunMessages]: (p: BunMessages[K]) => void };
};

/** Inside Toolbelt: Electrobun's RPC. In a plain browser (scripts/preview.ts): a WebSocket. */
const inApp = (window as { __electrobunWebviewId?: number }).__electrobunWebviewId !== undefined;

function connect(): Transport {
	if (inApp) {
		const r = Electroview.defineRPC<ToolbeltRPC>({ maxRequestTime: 10_000, handlers: { requests: {}, messages: handlers as never } });
		new Electroview({ rpc: r });
		return r as unknown as Transport;
	}
	const ws = new WebSocket(`ws://${location.host}/rpc`);
	const ready = new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
	let next = 1;
	const waiting = new Map<number, (m: { result?: unknown; error?: string }) => void>();
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.kind === "response") waiting.get(m.id)?.(m), waiting.delete(m.id);
		else if (m.kind === "message") (handlers as Record<string, (p: unknown) => void>)[m.name]?.(m.payload);
	});
	const proxy = <T,>(fn: (name: string, p: unknown) => T) => new Proxy({}, { get: (_, name: string) => (p: unknown) => fn(name, p) }) as never;
	return {
		request: proxy(async (method, params) => {
			await ready;
			const id = next++;
			ws.send(JSON.stringify({ kind: "request", id, method, params }));
			const m = await new Promise<{ result?: unknown; error?: string }>((ok) => waiting.set(id, ok));
			if (m.error) throw new Error(m.error);
			return m.result;
		}),
		send: proxy((name, payload) => void ready.then(() => ws.send(JSON.stringify({ kind: "message", name, payload })))),
	};
}

export const rpc = connect();
(window as { __tbReport?: unknown }).__tbReport = (id: number, value: unknown) => rpc.send.debugReport({ id, value });

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => void listeners.delete(l);
};

let loaded = false;
export function usePlugins(): PluginInfo[] {
	useEffect(() => {
		if (loaded) return;
		loaded = true;
		void rpc.request.plugins({}).then((plugins) => set({ plugins }));
	}, []);
	return useSyncExternalStore(subscribe, () => state.plugins);
}

/** Watch a surface while mounted; returns its latest UI tree (or null until the first one). */
export function useSurface(plugin: string, surface: string): Node | null {
	const k = key(plugin, surface);
	useEffect(() => {
		let live = true;
		void rpc.request.open({ plugin, surface }).then((tree) => {
			if (live && tree && !state.trees[k]) set({ trees: { ...state.trees, [k]: tree } });
		});
		return () => {
			live = false;
			void rpc.request.close({ plugin, surface });
		};
	}, [plugin, surface, k]);
	return useSyncExternalStore(subscribe, () => state.trees[k] ?? null);
}

/** Open a web link in the person's browser (only http, https and mailto). */
export function openUrl(url: string) {
	if (!/^(https?:|mailto:)/i.test(url)) return;
	if (inApp) void rpc.request.openUrl({ url });
	else window.open(url, "_blank", "noopener,noreferrer");
}

export const sendEvent = (plugin: string, surface: string, name: string, payload?: unknown) => void rpc.request.event({ plugin, surface, name, payload });
// For the debug channel: send plugin events from evaluated scripts.
(window as { __tbEvent?: unknown }).__tbEvent = sendEvent;

export function useNavigate(fn: NavListener) {
	useEffect(() => {
		navListeners.add(fn);
		return () => void navListeners.delete(fn);
	}, [fn]);
}

export function usePopoverShown(fn: () => void) {
	useEffect(() => {
		shownListeners.add(fn);
		return () => void shownListeners.delete(fn);
	}, [fn]);
}

export type ToolbeltSettings = Awaited<ReturnType<Transport["request"]["settings"]>>;

/** Toolbelt's own settings, kept fresh when they change in another view. */
export function useSettings(): [ToolbeltSettings | null, () => void] {
	const [s, setS] = useState<ToolbeltSettings | null>(null);
	const load = useCallback(() => void rpc.request.settings({}).then(setS), []);
	useEffect(() => {
		load();
		settingsListeners.add(load);
		return () => void settingsListeners.delete(load);
	}, [load]);
	return [s, load];
}
