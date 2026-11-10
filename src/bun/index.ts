import { createNativePopover } from "./native-popover";
// Toolbelt's main process: the menu bar icon and its popover, the main window, the global
// shortcut, and the plugin host that feeds both web views.
import Electrobun, {
  BrowserView,
  BrowserWindow,
  Screen,
  Updater,
  Utils,
  ApplicationMenu,
} from "electrobun/main";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginHost, configDir } from "./host";
import { PATHS } from "electrobun/main";
import { existsSync, readFileSync } from "node:fs";
import { PackageManager, type Candidate } from "./packages";
import { resolveGithub } from "./plugin-github";
import { pluginAsset } from "./plugin-assets";
import { FileIcons } from "./file-icon";
import { clearHotKey, displayAccelerator, setHotKey } from "./hotkey";
import {
  DEFAULTS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings";
import {
  setTrayHighlighted,
  setTrayTemplate,
  trayDark,
  trayHighlighted,
  trayTemplate,
} from "./tray-highlight";
import {
  SOON,
  Updater as AppUpdater,
  bundleOf,
  type UpdateState,
} from "./updater";
import type { ToolbeltRPC } from "../shared/rpc";
import { prepareAppHandoff } from "./activation";
import { appVariant } from "../shared/variant";
import pkg from "../../package.json" with { type: "json" };

/** The popover's width, and its tallest (quick views use all of it; the tool list asks for less). */
const POPOVER = { width: 380, height: 520 };
/** The height the tool list last asked for (`popoverSize`), used the next time it shows. */
let listHeight = POPOVER.height;
let popoverHeight = POPOVER.height;
const channel = await Updater.localInfo.channel();
const variant = appVariant(channel === "dev");
if (channel === "dev" && !process.env.TOOLBELT_CONFIG_DIR)
  process.env.TOOLBELT_CONFIG_DIR = join(
    homedir(),
    "Library/Application Support",
    variant.settingsFolder,
  );
let settings = loadSettings({ ...DEFAULTS, shortcut: variant.shortcut });
const devServer =
  channel === "dev" &&
  (await fetch("http://localhost:5173", { method: "HEAD" }).then(
    () => true,
    () => false,
  ));
const viewUrl = (hash = "") =>
  (devServer ? "http://localhost:5173/" : "views://ui/index.html") + hash;

// ── plugins ──────────────────────────────────────────────────────────────
const host = new PluginHost({
  dirs: [],
  registryRoot: configDir(homedir()),
  bun: process.execPath,
  host: { name: variant.name, version: pkg.version },
  data: join(configDir(homedir()), "data"),
});
const packages = new PackageManager(
  configDir(homedir()),
  {
    prepare: (id, reason) => host.prepare(id, reason),
    stop: (id) => host.stopPlugin(id),
    probe: (candidate, data) => host.probe(candidate, data),
    activate: (p) => host.activate(p),
    remove: (id) => host.remove(id),
  },
  pkg.version,
);
await packages.recover();
const candidates = new Map<string, Candidate>();
async function seedDemo() {
  const registry = packages.registry();
  if (registry.seeded) return;
  const seed = join(PATHS.RESOURCES_FOLDER, "app/seed");
  if (!existsSync(join(seed, "seed.json"))) return;
  const metadata = JSON.parse(readFileSync(join(seed, "seed.json"), "utf8"));
  const candidate = await packages.stage(
    new Uint8Array(readFileSync(join(seed, "demo.tar.gz"))),
    metadata.sha256,
    metadata.repo,
  );
  if (!registry.plugins[candidate.manifest.id])
    await packages.install(candidate, true);
  const latest = packages.registry();
  latest.seeded = true;
  const { atomicJSON } = await import("./packages");
  atomicJSON(join(configDir(homedir()), "plugins/registry.json"), latest);
}

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
        pluginManager: async (request) => {
          try {
            if (request.operation === "resolve") {
              const candidate = await resolveGithub(
                packages,
                request.repo ?? "",
                { release: request.release, prerelease: request.prerelease },
              );
              const token = crypto.randomUUID();
              candidates.set(token, candidate);
              return {
                candidate: {
                  token,
                  id: candidate.manifest.id,
                  name: candidate.manifest.name,
                  version: candidate.manifest.version,
                  repo: candidate.repo,
                  hash: candidate.hash,
                },
              };
            }
            if (request.operation === "install") {
              const candidate = candidates.get(request.token ?? "");
              if (!candidate)
                throw new Error("Resolve the release before approval");
              await packages.install(candidate, true);
              candidates.delete(request.token!);
            }
            if (request.operation === "enable")
              await packages.enabled(request.id!, !!request.enabled);
            if (request.operation === "remove")
              await packages.remove(request.id!, !!request.deleteData);
            return {
              installed: Object.values(packages.registry().plugins).filter(
                (p) => !p.removed,
              ),
            };
          } catch (error) {
            return { error: String(error) };
          }
        },
        pluginAsset: ({ reference }) => pluginAsset(packages, reference),
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
        event: async ({ plugin, surface, name, payload }): Promise<true> => {
          // Register Toolbelt as the foreground application before handing focus away.
          if ((name === "focus" || name === "focus-kept") && win) {
            await win.activate();
            prepareAppHandoff();
          }
          host.event(plugin, surface, name, payload);
          return true;
        },
        openUrl: ({ url }) =>
          /^(https?:|mailto:)/i.test(url) && Utils.openExternal(url),
        restartPlugin: ({ plugin }) => {
          host.restart(plugin);
          return true;
        },
        settings: () => ({
          shortcut: settings.shortcut,
          shortcutLabel: displayAccelerator(settings.shortcut),
          shortcutError,
          theme: settings.theme,
          mode: settings.mode,
        }),
        setAppearance: ({ theme, mode }) => {
          settings = {
            ...settings,
            ...(theme ? { theme } : {}),
            ...(mode ? { mode: mode as Settings["mode"] } : {}),
          };
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
        updateState: () => updater.state(),
        checkForUpdates: () => (void updater.check(), true),
        installUpdate: () => (void updater.install(), true),
        cancelUpdate: () => (updater.cancel(), true),
        dismissUpdate: () => (updater.dismiss(), true),
      },
      messages: {
        showWindow: ({ plugin, screen }) => {
          hidePopover(true);
          showWindow(plugin, screen);
        },
        hidePopover: () => hidePopover(),
        popoverSize: ({ height }) => {
          const h =
            height === null
              ? POPOVER.height
              : Math.round(Math.max(120, Math.min(POPOVER.height, height)));
          if (height !== null) listHeight = h;
          if (h === popoverHeight) return;
          popoverHeight = h;
          // Keep the top edge where it is (it hangs from the menu bar).
          const f = popover.getFrame();
          popover.setFrame(f.x, f.y, POPOVER.width, h);
        },
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
  tree: (plugin, surface, tree) =>
    views.forEach((v) => v.send.tree({ plugin, surface, tree })),
  toast: (plugin, text, tone, action) =>
    views.forEach((v) => v.send.toast({ plugin, text, tone, action })),
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
  updater.checkIfDue(SOON); // opening the window checks if it's been an hour
  winRPC = makeRPC();
  const hash = plugin ? `#/${plugin}${screen ? `/${screen}` : ""}` : "";
  win = new BrowserWindow({
    title: variant.name,
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
const popRPC=makeRPC();
const {tray,popover}=createNativePopover({title:variant.name,url:viewUrl("#popover"),image:channel==="dev"?"views://assets/tray-icon-dev@2x.png":"views://assets/tray-icon@2x.png",template:channel!=="dev",rpc:popRPC});
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
  const x = Math.round(
    Math.min(
      Math.max(b.x - 2, display.workArea.x + 4),
      display.workArea.x + display.workArea.width - POPOVER.width - 4,
    ),
  );
  const trayBottom = b.height
    ? display.bounds.height - b.y
    : display.workArea.y;
  const y = Math.round(trayBottom - 1);
  // It opens on the tool list, so at the list's height.
  popoverHeight = listHeight;
  popover.setFrame(x, y, POPOVER.width, popoverHeight);
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
const togglePopover = () =>
  popover.isVisible() && !hideTimer
    ? hidePopover()
    : Date.now() - hiddenAt < 300
      ? undefined
      : showPopover();

tray.on("tray-clicked", () => togglePopover());
// Clicking anywhere else dismisses it (ignore the blur that the click on the icon itself causes).
popover.on("blur", () => {
  if (Date.now() - popoverShownAt > 150) hidePopover();
});

// ── updates (official builds only; src/bun/updater.ts) ───────────────────
// An available update puts a red badge on the menu bar icon. A template image can't be red,
// so that one is a plain image, with the glyph drawn for the menu bar's current shade.
const TRAY_IMAGE =
  channel === "dev"
    ? "views://assets/tray-icon-dev@2x.png"
    : "views://assets/tray-icon@2x.png";
let trayAlert: null | "light" | "dark" = null;
function showTrayAlert(on: boolean) {
  const want = on ? (trayDark() ? "dark" : "light") : null;
  if (want === trayAlert) return;
  trayAlert = want;
  tray.setImage(
    want ? `views://assets/tray-icon-update-${want}@2x.png` : TRAY_IMAGE,
  );
  // Electrobun keeps the template flag it was created with; fix it once the image is in.
  for (const ms of [50, 400])
    setTimeout(() => setTrayTemplate(!trayAlert && channel !== "dev"), ms);
}

const updater = new AppUpdater({
  version: pkg.version,
  channel,
  feed: process.env.TOOLBELT_UPDATE_FEED,
  stateFile: join(configDir(homedir()), "update.json"),
  appPath: bundleOf(process.execPath),
  onChange: (s: UpdateState) => {
    views.forEach((v) => v.send.updateState(s));
    showTrayAlert(!!s.available);
  },
  // Start the new version once this one is gone, with its window open (and TOOLBELT_*
  // settings such as a test feed kept), then quit.
  relaunch: (app) => {
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const env = Object.entries({ ...process.env, TOOLBELT_OPEN_WINDOW: "1" })
      .filter(([k, v]) => k.startsWith("TOOLBELT_") && v !== undefined)
      .map(([k, v]) => `--env ${q(`${k}=${v}`)}`)
      .join(" ");
    Bun.spawn(
      [
        "/bin/sh",
        "-c",
        `(sleep 1; /usr/bin/open -n ${q(app)} ${env}) >/dev/null 2>&1 &`,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    ).unref();
    Utils.quit();
  },
});

let shortcutError = setHotKey(settings.shortcut, togglePopover);
if (shortcutError) console.error(`shortcut: ${shortcutError}`);

// ── app menu (Edit gives copy/paste/select-all in the web views) ─────────
ApplicationMenu.setApplicationMenu([
  {
    submenu: [
      {
        label: `Open ${variant.name}`,
        action: "open-window",
        accelerator: "CommandOrControl+O",
      },
      {
        label: "Settings…",
        action: "settings",
        accelerator: "CommandOrControl+,",
      },
      { label: "Check for Updates…", action: "check-updates" },
      { type: "separator" },
      { role: "hide", accelerator: "CommandOrControl+H" },
      { role: "hideOthers", accelerator: "CommandOrControl+Option+H" },
      { type: "separator" },
      {
        label: `Quit ${variant.name}…`,
        action: "quit",
        accelerator: "CommandOrControl+Q",
      },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      {
        label: "Toggle Sidebar",
        action: "toggle-sidebar",
        accelerator: "CommandOrControl+B",
      },
      { type: "separator" },
      {
        label: "Actual Size",
        action: "zoomReset",
        accelerator: "CommandOrControl+0",
      },
      {
        label: "Zoom In",
        action: "zoomIn",
        accelerator: "CommandOrControl+Plus",
      },
      {
        label: "Zoom Out",
        action: "zoomOut",
        accelerator: "CommandOrControl+Minus",
      },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize", accelerator: "CommandOrControl+M" },
      {
        label: "Close Window",
        role: "close",
        accelerator: "CommandOrControl+W",
      },
    ],
  },
]);
Electrobun.events.on("application-menu-clicked", (e: any) => {
  const action = e?.data?.action;
  if (action === "open-window") showWindow();
  if (action === "quit") requestQuit();
  if (action === "settings") showWindow("toolbelt");
  if (action === "check-updates") {
    showWindow("toolbelt");
    void updater.check();
  }
  if (action === "toggle-sidebar")
    winRPC?.send.command({ name: "toggleSidebar" });
  if (action === "zoomIn" || action === "zoomOut" || action === "zoomReset")
    winRPC?.send.command({ name: action });
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
  view.executeJavascript(
    `Promise.resolve().then(() => (${js})).then((v) => window.__tbReport(${id}, v), (e) => window.__tbReport(${id}, { error: String(e) }))`,
  );
  return new Promise((ok) => {
    reports.set(id, ok);
    setTimeout(
      () => reports.has(id) && (reports.delete(id), ok({ error: "timeout" })),
      30_000,
    );
  });
}
debugReport = (id, value) => {
  reports.get(id)?.(value);
  reports.delete(id);
};
// Also on an official build trying out an update (TOOLBELT_UPDATE_FEED), or with TOOLBELT_DEBUG.
if (
  (channel === "dev" ||
    process.env.TOOLBELT_UPDATE_FEED ||
    process.env.TOOLBELT_DEBUG) &&
  process.env.TOOLBELT_DEBUG_PORT
) {
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
          showWindow(
            q.get("plugin") ?? undefined,
            q.get("screen") ?? undefined,
          );
          break;
        case "/close":
          win?.close();
          break;
        case "/quit":
          requestQuit();
          break;
        case "/eval":
          return Response.json(
            await evalIn(
              q.get("target") === "window" ? "window" : "popover",
              await req.text(),
            ),
          );
      }
      return Response.json({
        popover: { visible: popover.isVisible(), frame: popover.getFrame() },
        window: win
          ? {
              visible: win.isVisible(),
              frame: win.getFrame(),
              buttons: win.getWindowButtonPosition(),
            }
          : null,
        shortcut: { accelerator: settings.shortcut, error: shortcutError },
        tray: tray.getBounds(),
        trayHighlighted: trayHighlighted(),
        trayTemplate: trayTemplate(),
        trayAlert,
        update: updater.state(),
        pid: process.pid,
        execPath: process.execPath,
        display: Screen.getPrimaryDisplay(),
        dock: Utils.isDockIconVisible(),
        plugins: host
          .list()
          .map((p) => ({ id: p.manifest.id, state: p.state, badge: p.badge })),
      });
    },
  });
  console.log(`debug channel on 127.0.0.1:${process.env.TOOLBELT_DEBUG_PORT}`);
}

Utils.setDockIconVisible(false);
host.start();
void seedDemo().catch((error) => console.error("SDK demo seed:", error));
if (process.env.TOOLBELT_OPEN_WINDOW) showWindow();
updater.start();
// Wake from sleep: the network takes a moment to come back, then see if a check is due (the
// 15-minute tick would get there too). Noticed as a gap in a once-a-minute heartbeat.
let heartbeat = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - heartbeat > 3 * 60_000)
    setTimeout(() => updater.checkIfDue(), 20_000);
  heartbeat = now;
  if (trayAlert) showTrayAlert(true); // the menu bar may have changed shade
}, 60_000);
console.log(
  `Toolbelt ${pkg.version} (${channel}) — plugins: ${
    host
      .list()
      .map((p) => p.manifest.id)
      .join(", ") || "none"
  }`,
);
