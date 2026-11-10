// Toolbelt's main process: the menu bar icon and its popover, the main window, the global
// shortcut, and the plugin host that feeds both web views.
import Electrobun, { BrowserView, BrowserWindow, Screen, Tray, Updater, Utils, ApplicationMenu } from "electrobun/main";
import { PATHS } from "electrobun/main";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginHost, configDir, pluginDirs } from "./host";
import { FileIcons } from "./file-icon";
import { clearHotKey, displayAccelerator, setHotKey } from "./hotkey";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { setTrayHighlighted, trayHighlighted } from "./tray-highlight";
import type { ToolbeltRPC } from "../shared/rpc";
import pkg from "../../package.json" with { type: "json" };

const POPOVER = { width: 380, height: 520 };
let settings = loadSettings();

const channel = await Updater.localInfo.channel();
const devServer = channel === "dev" && (await fetch("http://localhost:5173", { method: "HEAD" }).then(() => true, () => false));
const viewUrl = (hash = "") => (devServer ? "http://localhost:5173/" : "views://ui/index.html") + hash;

// ── plugins ──────────────────────────────────────────────────────────────
const host = new PluginHost({
	dirs: pluginDirs({ bundled: join(PATHS.RESOURCES_FOLDER, "app/plugins"), home: homedir(), extra: process.env.TOOLBELT_PLUGINS }),
	bun: process.execPath,
	host: { name: "Toolbelt", version: pkg.version },
	data: join(configDir(homedir()), "data"),
});

const icons = new FileIcons(join(configDir(homedir()), "cache/icons"));

let debugReport: (id: number, value: unknown) => void = () => {};

// Each web view gets its own RPC object; both see every plugin message.
type ViewRPC = ReturnType<typeof makeRPC>;
const views = new Set<ViewRPC>();
// Which surfaces each view has open, so a closed window releases them.
const opened = new Map<ViewRPC, Set<string>>();

function makeRPC() {
	const rpc: any = BrowserView.defineRPC<ToolbeltRPC>({
		maxRequestTime: 10_000,
		handlers: {
			requests: {
				plugins: () => host.list(),
				open: ({ plugin, surface }) => {
					opened.get(rpc)?.add(`${plugin}\n${surface}`);
					return host.open(plugin, surface);
				},
				close: ({ plugin, surface }) => {
					opened.get(rpc)?.delete(`${plugin}\n${surface}`);
					host.close(plugin, surface);
					return true;
				},
				event: ({ plugin, surface, name, payload }) => {
					host.event(plugin, surface, name, payload);
					return true;
				},
				openUrl: ({ url }) => /^(https?:|mailto:)/i.test(url) && Utils.openExternal(url),
				restartPlugin: ({ plugin }) => {
					host.restart(plugin);
					return true;
				},
				settings: () => ({ shortcut: settings.shortcut, shortcutLabel: displayAccelerator(settings.shortcut), shortcutError, theme: settings.theme, mode: settings.mode }),
				setAppearance: ({ theme, mode }) => {
					settings = { ...settings, ...(theme ? { theme } : {}), ...(mode ? { mode: mode as Settings["mode"] } : {}) };
					saveSettings(settings);
					views.forEach((v) => v.send.settingsChanged({}));
					return true;
				},
				setShortcut: ({ accelerator }) => {
					const error = setHotKey(accelerator, togglePopover);
					if (error) {
						// Put the working one back.
						setHotKey(settings.shortcut, togglePopover);
						return { ok: false, error };
					}
					settings = { ...settings, shortcut: accelerator };
					saveSettings(settings);
					shortcutError = null;
					views.forEach((v) => v.send.settingsChanged({}));
					return { ok: true, label: displayAccelerator(accelerator) };
				},
				// While the window records a new shortcut, the current one mustn't swallow the keys.
				fileIcon: ({ path }) => icons.get(path),
				pauseShortcut: ({ paused }) => {
					if (paused) clearHotKey();
					else setHotKey(settings.shortcut, togglePopover);
					return true;
				},
			},
			messages: {
				showWindow: ({ plugin, screen }) => {
					hidePopover(true);
					showWindow(plugin, screen);
				},
				hidePopover: () => hidePopover(),
				closeWindow: () => win?.close(),
				// Double-clicking the title area: zoom like a native title bar.
				zoomWindow: () => {
					if (!win) return;
					if (win.isMaximized()) win.unmaximize();
					else win.maximize();
				},
				debugReport: ({ id, value }) => debugReport(id, value),
				quit: () => Utils.quit(),
			},
		},
	});
	views.add(rpc);
	opened.set(rpc, new Set());
	return rpc as ReturnType<typeof BrowserView.defineRPC<ToolbeltRPC>>;
}

function releaseView(rpc: ViewRPC) {
	for (const key of opened.get(rpc) ?? []) {
		const [plugin, surface] = key.split("\n");
		host.close(plugin, surface);
	}
	opened.delete(rpc);
	views.delete(rpc);
}

host.subscribe({
	plugins: (list) => views.forEach((v) => v.send.plugins(list)),
	tree: (plugin, surface, tree) => views.forEach((v) => v.send.tree({ plugin, surface, tree })),
	toast: (plugin, text, tone, action) => views.forEach((v) => v.send.toast({ plugin, text, tone, action })),
	clipboard: (_plugin, text) => Utils.clipboardWriteText(text),
});

// ── main window ──────────────────────────────────────────────────────────
// Created on demand and destroyed when closed. The Dock icon (and ⌘-Tab) only while it's open.
let win: BrowserWindow | null = null;
let winRPC: ViewRPC | null = null;

function showWindow(plugin?: string, screen?: string) {
	if (win) {
		win.unminimize();
		win.show();
		win.activate();
		if (plugin) winRPC?.send.navigate({ plugin, screen });
		return;
	}
	Utils.setDockIconVisible(true);
	winRPC = makeRPC();
	const hash = plugin ? `#/${plugin}${screen ? `/${screen}` : ""}` : "";
	win = new BrowserWindow({
		title: "Toolbelt",
		url: viewUrl(hash),
		frame: { width: 1180, height: 760 },
		titleBarStyle: "hiddenInset",
		trafficLightOffset: { x: 6, y: 6 },
		rpc: winRPC,
	});
	win.on("close", () => {
		if (winRPC) releaseView(winRPC);
		win = null;
		winRPC = null;
		Utils.setDockIconVisible(false);
	});
}

// ── menu bar icon + popover ──────────────────────────────────────────────
// No native menu: a click sends `tray-clicked`, and we show our own (shadcn) popover under it.
const tray = new Tray({ title: "", image: "views://assets/tray-icon@2x.png", template: true, width: 18, height: 18 });

const popRPC = makeRPC();
const popover = new BrowserWindow({
	title: "Toolbelt",
	url: viewUrl("#popover"),
	frame: { width: POPOVER.width, height: POPOVER.height, x: 0, y: 0 },
	titleBarStyle: "hidden",
	styleMask: { Resizable: false, Miniaturizable: false, Closable: false },
	transparent: true,
	hidden: true,
	activate: false,
	rpc: popRPC,
});
popover.setAlwaysOnTop(true);
popover.setVisibleOnAllWorkspaces(true);
let popoverShownAt = 0;

/** How long the popover's closing animation plays before the window hides (ms). */
const POPOVER_CLOSE_MS = 160;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenAt = 0;

function showPopover() {
	clearTimeout(hideTimer);
	hideTimer = undefined;
	const b = tray.getBounds();
	const display = Screen.getPrimaryDisplay();
	// Like a macOS menu: hanging from the menu bar, left edge just left of the icon (and kept on
	// screen). Window frames are top-left based, but tray bounds come back in Cocoa's bottom-left
	// coordinates — flip them.
	const x = Math.round(Math.min(Math.max(b.x - 2, display.workArea.x + 4), display.workArea.x + display.workArea.width - POPOVER.width - 4));
	const trayBottom = b.height ? display.bounds.height - b.y : display.workArea.y;
	const y = Math.round(trayBottom - 1);
	popover.setFrame(x, y, POPOVER.width, POPOVER.height);
	popover.show();
	popover.activate();
	setTrayHighlighted(true);
	popoverShownAt = Date.now();
	popRPC.send.popoverShown({});
}

/** Plays the closing animation, then hides the window. `now`: skip the animation. */
function hidePopover(now = false) {
	setTrayHighlighted(false);
	if (!popover.isVisible() || hideTimer) return;
	hiddenAt = Date.now();
	if (now) return popover.hide();
	popRPC.send.popoverHiding({});
	hideTimer = setTimeout(() => {
		hideTimer = undefined;
		popover.hide();
	}, POPOVER_CLOSE_MS);
}

// A click on the menu bar icon while the popover is open blurs it first (which starts hiding);
// that click means "close", not "open again".
const togglePopover = () => (popover.isVisible() && !hideTimer ? hidePopover() : Date.now() - hiddenAt < 300 ? undefined : showPopover());

tray.on("tray-clicked", () => togglePopover());
// Clicking anywhere else dismisses it (ignore the blur that the click on the icon itself causes).
popover.on("blur", () => {
	if (Date.now() - popoverShownAt > 150) hidePopover();
});

let shortcutError = setHotKey(settings.shortcut, togglePopover);
if (shortcutError) console.error(`shortcut: ${shortcutError}`);

// ── app menu (Edit gives copy/paste/select-all in the web views) ─────────
ApplicationMenu.setApplicationMenu([
	{
		submenu: [
			{ label: "Open Toolbelt", action: "open-window", accelerator: "CommandOrControl+O" },
			{ label: "Settings…", action: "settings", accelerator: "CommandOrControl+," },
			{ type: "separator" },
			{ role: "hide", accelerator: "CommandOrControl+H" },
			{ role: "hideOthers", accelerator: "CommandOrControl+Option+H" },
			{ type: "separator" },
			{ label: "Quit Toolbelt…", action: "quit", accelerator: "CommandOrControl+Q" },
		],
	},
	{
		label: "Edit",
		submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
	},
	{
		label: "View",
		submenu: [
			{ label: "Toggle Sidebar", action: "toggle-sidebar", accelerator: "CommandOrControl+B" },
			{ type: "separator" },
			{ label: "Actual Size", action: "zoomReset", accelerator: "CommandOrControl+0" },
			{ label: "Zoom In", action: "zoomIn", accelerator: "CommandOrControl+Plus" },
			{ label: "Zoom Out", action: "zoomOut", accelerator: "CommandOrControl+Minus" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "minimize", accelerator: "CommandOrControl+M" },
			{ label: "Close Window", role: "close", accelerator: "CommandOrControl+W" },
		],
	},
]);
Electrobun.events.on("application-menu-clicked", (e: any) => {
	const action = e?.data?.action;
	if (action === "open-window") showWindow();
	if (action === "quit") requestQuit();
	if (action === "settings") showWindow("toolbelt");
	if (action === "toggle-sidebar") winRPC?.send.command({ name: "toggleSidebar" });
	if (action === "zoomIn" || action === "zoomOut" || action === "zoomReset") winRPC?.send.command({ name: action });
});
/** ⌘Q: ask first, in the popover if it's open, else in the window, else open the popover to ask. */
function requestQuit() {
	if (popover.isVisible()) return popRPC.send.confirmQuit({});
	if (win) {
		win.activate();
		return winRPC?.send.confirmQuit({});
	}
	showPopover();
	popRPC.send.confirmQuit({});
}

// Clicking the Dock icon while the window is closed (shouldn't happen, but be kind).
Electrobun.events.on("reopen", () => showWindow());
Electrobun.events.on("before-quit", () => host.stop());

// ── debug channel (dev builds, TOOLBELT_DEBUG_PORT) ─────────────────────
// Drive and inspect the real app without screen recording: show/hide things, read state, and
// evaluate JavaScript in a web view (the value comes back through RPC).
const reports = new Map<number, (v: unknown) => void>();
let reportId = 1;
function evalIn(target: "popover" | "window", js: string): Promise<unknown> {
	const view = target === "popover" ? popover.webview : win?.webview;
	if (!view) return Promise.resolve({ error: `no ${target}` });
	const id = reportId++;
	view.executeJavascript(`Promise.resolve().then(() => (${js})).then((v) => window.__tbReport(${id}, v), (e) => window.__tbReport(${id}, { error: String(e) }))`);
	return new Promise((ok) => {
		reports.set(id, ok);
		setTimeout(() => reports.has(id) && (reports.delete(id), ok({ error: "timeout" })), 30_000);
	});
}
debugReport = (id, value) => {
	reports.get(id)?.(value);
	reports.delete(id);
};
if (channel === "dev" && process.env.TOOLBELT_DEBUG_PORT) {
	Bun.serve({
		hostname: "127.0.0.1",
		port: Number(process.env.TOOLBELT_DEBUG_PORT),
		async fetch(req) {
			const url = new URL(req.url);
			const q = url.searchParams;
			switch (url.pathname) {
				case "/popover":
					showPopover();
					break;
				case "/hide":
					hidePopover();
					break;
				case "/window":
					showWindow(q.get("plugin") ?? undefined, q.get("screen") ?? undefined);
					break;
				case "/close":
					win?.close();
					break;
				case "/quit":
					requestQuit();
					break;
				case "/eval":
					return Response.json(await evalIn(q.get("target") === "window" ? "window" : "popover", await req.text()));
			}
			return Response.json({
				popover: { visible: popover.isVisible(), frame: popover.getFrame() },
				window: win ? { visible: win.isVisible(), frame: win.getFrame(), buttons: win.getWindowButtonPosition() } : null,
				shortcut: { accelerator: settings.shortcut, error: shortcutError },
				tray: tray.getBounds(),
				trayHighlighted: trayHighlighted(),
				display: Screen.getPrimaryDisplay(),
				dock: Utils.isDockIconVisible(),
				plugins: host.list().map((p) => ({ id: p.manifest.id, state: p.state, badge: p.badge })),
			});
		},
	});
	console.log(`debug channel on 127.0.0.1:${process.env.TOOLBELT_DEBUG_PORT}`);
}

Utils.setDockIconVisible(false);
host.start();
if (process.env.TOOLBELT_OPEN_WINDOW) showWindow();
console.log(`Toolbelt ${pkg.version} (${channel}) — plugins: ${host.list().map((p) => p.manifest.id).join(", ") || "none"}`);
