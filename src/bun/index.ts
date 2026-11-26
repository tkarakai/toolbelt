import type { NavigationSelection, WindowNavigation } from "../shared/navigation";
import { localControlRequest } from "./loopback";
import { materializeSeed } from "./seed";
import { EDIT_MENU } from "./edit-menu";
import { createNativePopover, layoutNativePopover } from "./native-popover";
// ToolBelt's main process: the menu bar icon and its popover, the main window, the global
// shortcut, and the plugin host that feeds both web views.
import Electrobun, {
  BrowserView,
  BrowserWindow,
  Screen,
  Updater,
  Utils,
  ApplicationMenu,
} from "electrobun/main";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEVELOPMENT_ENV,
  DevelopmentController,
  DiagnosticLog,
  LocalArchives,
  developmentProfileName,
  developmentRoot,
} from "./development";
import type { DevelopmentRequest } from "../shared/development";
import { PluginHost, configDir } from "./host";
import { PATHS } from "electrobun/main";
import { PackageManager, type Installed } from "./packages";
import { PluginManagerService } from "./plugin-manager-service";
import { pluginAsset } from "./plugin-assets";
import { FileIcons } from "./file-icon";
import { clearHotKey, displayAccelerator, setHotKey } from "./hotkey";
import {
  DEFAULTS,
  loadSettings,
  saveSettings,
  settingsDir,
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
import { captureFrontApplication, focusWindowContent, prepareAppHandoff } from "./activation";
import { appVariant } from "../shared/variant";
import { RemoteAccess } from "./remote-access";
import { buildIdOf, remoteSender } from "./remote-server";
import { REMOTE_DEFAULT_PORT } from "../shared/remote";
import { createAgentInterface, declaredAccess } from "./agent";
import { ViewStore } from "./views";
import { cleanView } from "../shared/views";
import { PERSON } from "../shared/protocol";
import pkg from "../../package.json" with { type: "json" };

// Nothing a plugin does, and no error after startup, ends ToolBelt: a stray one is logged instead.
process.on("uncaughtException", (error) => console.error("uncaught:", error));
process.on("unhandledRejection", (error) => console.error("unhandled rejection:", error));

/** Last requested list geometry, reused when the native popover is shown again. */
let listHeight = 520;
let popoverDetails = false;
let popoverAnchorTop = 0;
const channel = await Updater.localInfo.channel();
const variant = appVariant(channel === "dev");
if (channel === "dev" && !process.env.TOOLBELT_CONFIG_DIR)
  process.env.TOOLBELT_CONFIG_DIR = join(
    homedir(),
    "Library/Application Support",
    variant.settingsFolder,
  );
let settings = loadSettings({
  ...DEFAULTS,
  shortcut: variant.shortcut,
  // ToolBelt Dev listens on the next port so both apps can serve at once.
  remote: { ...DEFAULTS.remote, port: REMOTE_DEFAULT_PORT + (channel === "dev" ? 1 : 0) },
});
// Plugin development mode (docs/plugin-development.md): one mode per process. Settings stay
// shared with normal mode; plugin registry, packages and data use the development profile.
const configRoot = configDir(homedir());
const developmentProfile = (() => {
  const requested = process.env[DEVELOPMENT_ENV];
  if (!requested) return null;
  try {
    return developmentProfileName(requested);
  } catch (error) {
    console.error(`${DEVELOPMENT_ENV}: ${String(error)}; starting in normal mode`);
    return null;
  }
})();
const profileRoot = developmentProfile
  ? developmentRoot(configRoot, developmentProfile)
  : configRoot;
mkdirSync(profileRoot, { recursive: true });
/** The amber menu-bar glyph marks ToolBelt Dev builds and development mode. */
const amberTray = channel === "dev" || !!developmentProfile;
const devServer =
  channel === "dev" &&
  (await fetch("http://localhost:5173", { method: "HEAD" }).then(
    () => true,
    () => false,
  ));
const profileQuery = process.env.TOOLBELT_CONFIG_DIR || developmentProfile
  ? "?profile=" +
    new Bun.CryptoHasher("sha256")
      .update(profileRoot)
      .digest("hex")
      .slice(0, 24)
  : "";
const viewUrl = (hash = "") =>
  (devServer ? "http://localhost:5173/" : "views://ui/index.html") +
  profileQuery +
  hash;

// ── plugins ──────────────────────────────────────────────────────────────
const developmentLog = new DiagnosticLog();
// The person's view of each screen, shared by every person's screen and saved by the host.
const personViews = new ViewStore(join(profileRoot, "views.json"));
const host = new PluginHost({
  dirs: [],
  registryRoot: profileRoot,
  bun: process.execPath,
  host: { name: variant.name, version: pkg.version },
  data: join(profileRoot, "data"),
  views: personViews,
  ...(developmentProfile
    ? {
        diagnostic: (plugin: string, kind: string, detail: unknown) =>
          developmentLog.record(kind, { plugin, detail }),
      }
    : {}),
});
const packages = new PackageManager(
  profileRoot,
  {
    prepare: (id, reason) => host.prepare(id, reason),
    stop: (id) => host.stopPlugin(id),
    probe: (candidate, data) => host.probe(candidate, data),
    activate: (p) => host.activate(p),
    remove: (id) => host.remove(id),
  },
  pkg.version,
  undefined,
  undefined,
  !!developmentProfile,
);
// Recovery problems are reported in Settings → Plugins; they never stop ToolBelt from starting.
await packages.recover().catch((error) => {
  console.error("plugin recovery:", error);
  packages.recoveryWarnings.push(`Plugin recovery stopped: ${error instanceof Error ? error.message : String(error)}`);
});
const manager = new PluginManagerService(packages, host);
// ── agent interface (docs/agent-interface.md) ─────────────────────────────────────
const agents = createAgentInterface({
  host,
  settings: () => settings.agents,
  save: (next) => {
    settings = { ...settings, agents: next };
    saveSettings(settings);
  },
  // The bundle this process runs from (…/ToolBelt Dev.app/Contents/MacOS/bun), so agents can tell builds apart.
  app: () => ({ name: variant.name, version: pkg.version, channel, developmentProfile, location: process.execPath.match(/^(.*?\.app)\//)?.[1] ?? null }),
  appUpdate: () => {
    const s = updater.state();
    return { available: s.available?.version ?? null, lastChecked: s.lastChecked };
  },
  installed: () =>
    manager.read().plugins.map((p) => ({
      id: p.id,
      name: p.manifest.name,
      version: p.manifest.version,
      repo: p.repo,
      enabled: p.enabled,
      phase: p.phase,
      availableVersion: p.availableVersion,
      channel: p.channel,
      declared: declaredAccess(p.manifest),
    })),
  configRoot,
  profileRoot,
  cliScript: join(PATHS.RESOURCES_FOLDER, "app/cli/toolbelt.js"),
  bun: process.execPath,
  // Paired remote devices are trusted like the Mac: they get Settings → Agents too.
  changed: (state) => views.forEach((v) => v.send.agentsState(state)),
  // What show_screen changes: the person's screens (the Mac's window and paired devices).
  person: {
    devices: () => [
      { name: "the Mac", kind: "mac" as const, showing: !!win },
      ...remoteAccess.devices().map((d) => ({ name: d.name, kind: "device" as const, showing: d.connected })),
    ],
    openWindow: () => showWindow(),
    navigate: (plugin, screen) => {
      if (win) winRPC?.send.navigate({ plugin, screen });
      for (const view of views) if (remoteViews.has(view)) view.send.navigate({ plugin, screen });
    },
    view: (plugin, surface) => host.personView(plugin, surface),
    setView: (plugin, surface, view) => {
      const clean = cleanView(host.declaredView(plugin, surface) ?? undefined, view);
      // Open somewhere: the plugin applies it and reports it back to be saved. Else saved for next time.
      if ((host.snapshot(plugin, surface, PERSON)?.viewers ?? 0) > 0) host.setView(plugin, surface, PERSON, clean);
      else personViews.save(plugin, surface, clean);
    },
  },
});
const seedDemo = () =>
  materializeSeed(packages, join(PATHS.RESOURCES_FOLDER, "app/seed"));

const icons = new FileIcons(join(profileRoot, "cache/icons"));
const localArchives = developmentProfile
  ? new LocalArchives(packages, developmentLog, () => broadcastDevelopment())
  : null;

let debugReport: (id: number, value: unknown) => void = () => {};

// Each web view gets its own RPC object, and each remote connection (src/bun/remote-access.ts)
// a view of its own; all of them see every plugin message.
type ViewRPC = ReturnType<typeof makeRPC>;
type View = { send: ViewRPC["send"] };
const views = new Set<View>();
// Which surfaces each view has open, so a closed window releases them.
const opened = new Map<View, Set<string>>();
const remoteViews = new WeakSet<View>();
/** The view that sent the latest plugin event: a plugin's navigation goes back to it. */
let lastEvent: { view: View; plugin: string; at: number } | null = null;
let pluginUpdateAvailable = manager.read().plugins.some(p => !p.removed && !!p.availableVersion);
manager.subscribe((state) => {
  views.forEach((view) => view.send.pluginManagerState(state));
  pluginUpdateAvailable = state.plugins.some(p => !p.removed && !!p.availableVersion);
  showTrayAlert(pluginUpdateAvailable || !!updater.state().available);
});

type Requests = ToolbeltRPC["bun"]["requests"];
type RequestHandlers = {
  [K in keyof Requests]: (
    params: Requests[K]["params"],
  ) => Requests[K]["response"] | Promise<Requests[K]["response"]>;
};

/** The request handlers for one view (web view or remote connection). */
function requestHandlers(view: () => View): RequestHandlers {
  return {
        initialNavigation: () => {
          if (view() !== winRPC) return null;
          if (pendingWindowFocus && win) {
            pendingWindowFocus = false;
            prepareAppHandoff();
            win.activate();
            focusWindowContent(win.ptr);
          }
          const navigation = pendingWindowNavigation;
          pendingWindowNavigation = null;
          return navigation;
        },
        popoverLayout: ({ height, details, anchorTop, reserveHeight }) => {
          listHeight = Number.isFinite(height) ? Math.max(120, Math.min(520, height)) : 520;
          popoverDetails = details === true;
          popoverAnchorTop = Number.isFinite(anchorTop) ? Math.max(0, Math.min(520, anchorTop)) : 0;
          return layoutNativePopover(tray, popover, listHeight, popoverDetails, popoverAnchorTop,
            Number.isFinite(reserveHeight) ? Math.max(0, reserveHeight!) : 0);
        },
        pluginManager: (request) => manager.handle(request),
        pluginAsset: ({ reference }) => pluginAsset(packages, reference),
        plugins: () => host.list(),
        // The host counts viewers per surface, so each view holds at most one count: a view that
        // opens again (a remote reconnect or resync) or closes twice must not change it.
        open: ({ plugin, surface }) => {
          const surfaces = opened.get(view());
          const key = `${plugin}\n${surface}`;
          if (!surfaces || surfaces.has(key)) return host.tree(plugin, surface);
          surfaces.add(key);
          return host.open(plugin, surface);
        },
        close: ({ plugin, surface }) => {
          if (opened.get(view())?.delete(`${plugin}\n${surface}`)) host.close(plugin, surface);
          return true;
        },
        event: async ({ plugin, surface, name, payload }): Promise<true> => {
          if (packages.upgradingHost)
            throw new Error(
              "ToolBelt is preparing to update; plugin actions are temporarily deferred",
            );
          lastEvent = { view: view(), plugin, at: Date.now() };
          // Register ToolBelt as the foreground application before handing focus away.
          if (
            host
              .list()
              .find((p) => p.manifest.id === plugin)
              ?.manifest.handoffActions?.includes(name) &&
            win
          ) {
            await win.activate();
            prepareAppHandoff();
          }
          host.event(plugin, surface, name, payload);
          return true;
        },
        openUrl: ({ url }) =>
          /^(https?:|mailto:)/i.test(url) && Utils.openExternal(url),
        restartPlugin: async ({ plugin }): Promise<true> => {
          try {
            await host.restart(plugin);
          } catch (error) {
            views.forEach((view) =>
              view.send.toast({ plugin, text: String(error), tone: "error" }),
            );
            throw error;
          }
          return true;
        },
        settings: () => ({
          shortcut: settings.shortcut,
          shortcutLabel: displayAccelerator(settings.shortcut),
          shortcutError,
          theme: settings.theme,
          mode: settings.mode,
          badgePlugins: settings.remote.badgePlugins,
        }),
        remoteAccess: (request) => remoteAccess.handle(request),
        agents: (request) => agents.handle(request),
        buildId: () => (remoteViews.has(view()) ? buildIdOf(remoteRoot) : null),
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
        development: (request) => developmentRequest(request),
        updateState: () => updater.state(),
        checkForUpdates: () => (void updater.check(), true),
        installUpdate: () => (void updater.install(), true),
        cancelUpdate: () => (updater.cancel(), true),
        dismissUpdate: () => (updater.dismiss(), true),
  };
}

function makeRPC() {
  const rpc: any = BrowserView.defineRPC<ToolbeltRPC>({
    maxRequestTime: 300_000,
    handlers: {
      requests: requestHandlers(() => rpc),
      messages: {
        selectionChanged: payload => views.forEach(view => view.send.selectionChanged(payload)),
        showWindow: ({ plugin, screen, selection }) => {
          showWindow(plugin, screen, selection);
        },
        hidePopover: () => hidePopover(false, true),
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

function releaseView(rpc: View) {
  for (const key of opened.get(rpc) ?? []) {
    const [plugin, surface] = key.split("\n");
    host.close(plugin, surface);
  }
  opened.delete(rpc);
  views.delete(rpc);
}

host.subscribe({
  plugins: (list) => views.forEach((v) => v.send.plugins(list)),
  // People's screens show the person's instance; agent instances are the agent interface's.
  tree: (plugin, surface, tree, instance) => {
    if (instance === PERSON) views.forEach((v) => v.send.tree({ plugin, surface, tree }));
  },
  toast: (plugin, text, tone, action) =>
    views.forEach((v) => v.send.toast({ plugin, text, tone, action })),
  clipboard: (_plugin, text) => Utils.clipboardWriteText(text),
  navigate: (plugin, screen, select) => {
    const selection = select ? { item: select } : undefined;
    // The host honors navigation only shortly after an event; it belongs to the view that sent it.
    const origin = lastEvent?.plugin === plugin && Date.now() - lastEvent.at < 10_000 ? lastEvent.view : null;
    if (origin && remoteViews.has(origin) && views.has(origin))
      return origin.send.navigate({ plugin, screen, selection });
    showWindow(plugin, screen, selection);
  },
});

// ── remote access (docs/remote-access.md) ───────────────────────────────
// Remote connections get the same request handlers as a web view, minus the ones that only
// make sense on the Mac: the popover's geometry, plugin development mode's control plane, the
// global shortcut (a dropped connection while recording would leave it paused).
const REMOTE_EXCLUDED = new Set<string>(["popoverLayout", "development", "setShortcut", "pauseShortcut"]);
const remoteRoot = join(PATHS.VIEWS_FOLDER, "ui");
const remoteClients = new Map<number, { view: View; handlers: RequestHandlers }>();
const remoteAccess = new RemoteAccess({
  settings: () => settings.remote,
  // Beside settings.json: shared by normal and plugin development mode, like the settings.
  devicesFile: join(settingsDir(), "remote-devices.json"),
  save: (remote) => {
    const badgeChanged = remote.badgePlugins.join("\n") !== settings.remote.badgePlugins.join("\n");
    settings = { ...settings, remote };
    saveSettings(settings);
    if (badgeChanged) views.forEach((v) => v.send.settingsChanged({}));
  },
  root: remoteRoot,
  changed: (state) => views.forEach((v) => v.send.remoteAccessState(state)),
  handlers: {
    opened: (client) => {
      const view: View = { send: remoteSender<ViewRPC["send"]>(client) };
      remoteViews.add(view);
      views.add(view);
      opened.set(view, client.opened);
      remoteClients.set(client.id, { view, handlers: requestHandlers(() => view) });
    },
    closed: (client) => {
      const entry = remoteClients.get(client.id);
      remoteClients.delete(client.id);
      if (entry) releaseView(entry.view);
    },
    request: (client, method, params) => {
      const entry = remoteClients.get(client.id);
      const handler = entry && !REMOTE_EXCLUDED.has(method)
        ? (entry.handlers as Record<string, ((p: unknown) => unknown) | undefined>)[method]
        : undefined;
      // Unknown methods fail closed.
      if (!handler) throw new Error(`Unknown method ${method}`);
      return handler(params);
    },
    message: (_client, name, payload) => {
      if (name === "selectionChanged")
        views.forEach((view) => view.send.selectionChanged(payload as never));
      else if (name === "quit") Utils.quit();
    },
  },
});

// ── main window ──────────────────────────────────────────────────────────
// Created on demand and destroyed when closed. The Dock icon (and ⌘-Tab) only while it's open.
let win: BrowserWindow | null = null;
let winRPC: ViewRPC | null = null;

let pendingWindowNavigation: WindowNavigation | null = null;
let pendingWindowFocus = false;
function showWindow(plugin?: string, screen?: string, selection?: NavigationSelection) {
  hidePopover(true);
  prepareAppHandoff();
  if (win) {
    win.unminimize();
    win.show();
    win.activate();
    focusWindowContent(win.ptr);
    if (plugin) winRPC?.send.navigate({ plugin, screen, selection });
    return;
  }
  Utils.setDockIconVisible(true);
  updater.checkIfDue(SOON, "window"); // opening the window checks if it's been an hour
  winRPC = makeRPC();
  pendingWindowNavigation = plugin ? { plugin, screen, selection } : null;
  const hash = plugin ? `#/${plugin}${screen ? `/${screen}` : ""}` : "";
  pendingWindowFocus = true;
  win = new BrowserWindow({
    title: developmentProfile
      ? `${variant.name} — Plugin development (${developmentProfile})`
      : variant.name,
    url: viewUrl(hash),
    frame: { width: 1180, height: 760 },
    titleBarStyle: "hiddenInset",
    trafficLightOffset: { x: 6, y: 6 },
    rpc: winRPC,
  });
  win.activate();
  win.on("close", () => {
    if (winRPC) releaseView(winRPC);
    win = null;
    winRPC = null;
    pendingWindowNavigation = null;
    pendingWindowFocus = false;
    Utils.setDockIconVisible(false);
  });
}

// ── menu bar icon + popover ──────────────────────────────────────────────
// No native menu: a click sends `tray-clicked`, and we show our own (shadcn) popover under it.
const popRPC = makeRPC();
const { tray, popover } = createNativePopover({
  title: variant.name,
  url: viewUrl("#popover"),
  image: amberTray
    ? "views://assets/tray-icon-dev@2x.png"
    : "views://assets/tray-icon@2x.png",
  template: !amberTray,
  rpc: popRPC,
});
let popoverShownAt = 0;

/** How long the popover's closing animation plays before the window hides (ms). */
const POPOVER_CLOSE_MS = 160;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenAt = 0;

let restorePopoverApplication: (() => void) | undefined;
function showPopover() {
  if (!popover.isVisible()) restorePopoverApplication = captureFrontApplication();
  clearTimeout(hideTimer);
  hideTimer = undefined;
  layoutNativePopover(tray, popover, listHeight, popoverDetails, popoverAnchorTop);
  popover.show();
  popover.activate();
  setTrayHighlighted(true);
  popoverShownAt = Date.now();
  popRPC.send.popoverShown({});
}

/** Plays the closing animation, then hides the window. `now`: skip the animation. */
function hidePopover(now = false, restore = false) {
  setTrayHighlighted(false);
  if (now) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
    restorePopoverApplication = undefined;
    if (popover.isVisible()) { hiddenAt = Date.now(); popover.hide(); }
    return;
  }
  if (!popover.isVisible() || hideTimer) return;
  hiddenAt = Date.now();
  popRPC.send.popoverHiding({});
  hideTimer = setTimeout(() => {
    hideTimer = undefined;
    popover.hide();
    if (restore) restorePopoverApplication?.();
    restorePopoverApplication = undefined;
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

setTimeout(() => setTrayTemplate(!trayAlert && !amberTray), 500);
tray.on("tray-clicked", () => togglePopover());
// Clicking anywhere else dismisses it (ignore the blur that the click on the icon itself causes).
popover.on("blur", () => {
  if (Date.now() - popoverShownAt > 150) hidePopover();
});

// ── updates (official builds only; src/bun/updater.ts) ───────────────────
// Available updates use a neutral badge drawn for the menu bar’s current shade.
const TRAY_IMAGE = amberTray
  ? "views://assets/tray-icon-dev@2x.png"
  : "views://assets/tray-icon@2x.png";
let trayAlert: null | "light" | "dark" = null;
function showTrayAlert(on: boolean) {
  const want = on ? (trayDark() ? "dark" : "light") : null;
  if (want === trayAlert) return;
  trayAlert = want;
  tray.setImage(
    // Dev builds keep their orange glyph under the update badge.
    want ? `views://assets/tray-icon${amberTray ? "-dev" : ""}-update-${want}@2x.png` : TRAY_IMAGE,
  );
  // Electrobun keeps the template flag it was created with; fix it once the image is in.
  for (const ms of [50, 400])
    setTimeout(() => setTrayTemplate(!trayAlert && !amberTray), ms);
}

// App updates and mode switches stop this process: every running plugin must prepare first.
// A refusal (or failure) leaves the refusing plugin untouched and reactivates the others.
let preparedForRelaunch: Installed[] = [];
async function prepareForRelaunch(reason: string) {
  packages.beginHostUpgrade();
  for (const plugin of host.list().filter((p) => p.state === "running")) {
    const installed = packages.registry().plugins[plugin.manifest.id];
    if (installed) {
      try {
        await host.prepare(installed.id, reason);
      } catch (error) {
        throw new Error(
          `${installed.manifest.name} can't stop right now: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      preparedForRelaunch.push(installed);
    }
  }
}
async function resumeAfterRelaunchFailure() {
  packages.endHostUpgrade();
  for (const p of preparedForRelaunch.splice(0)) {
    const current = packages.registry().plugins[p.id];
    if (current?.enabled && !current.removed) await host.activate(current);
  }
}
/** Starts `app` once this process is gone (TOOLBELT_* settings kept, as given), then quits. */
function relaunch(app: string, environment: Record<string, string | undefined>) {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const env = Object.entries(environment)
    .filter(
      ([k, v]) =>
        (k.startsWith("TOOLBELT_") ||
          ["HOME", "SHELL", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER"].includes(k)) &&
        v !== undefined,
    )
    .map(([k, v]) => `--env ${q(`${k}=${v}`)}`)
    .join(" ");
  Bun.spawn(
    ["/bin/sh", "-c", `(sleep 1; /usr/bin/open -n ${q(app)} ${env}) >/dev/null 2>&1 &`],
    { stdio: ["ignore", "ignore", "ignore"] },
  ).unref();
  Utils.quit();
}
const updater = new AppUpdater({
  prepareInstall: () => prepareForRelaunch("host-upgrade"),
  resumeInstall: resumeAfterRelaunchFailure,
  preflight: (version) => {
    const incompatible = Object.values(packages.registry().plugins).filter(
      (p) =>
        p.enabled &&
        !p.removed &&
        !Bun.semver.satisfies(version, p.manifest.requires.host),
    );
    if (incompatible.length)
      throw new Error(
        `Update or disable these plugins before installing ToolBelt ${version}: ${incompatible.map((p) => p.manifest.name).join(", ")}`,
      );
  },
  version: pkg.version,
  channel,
  feed: process.env.TOOLBELT_UPDATE_FEED,
  // Development mode never replaces the app; its update state stays in the development profile.
  ...(developmentProfile ? { enabled: false } : {}),
  stateFile: join(profileRoot, "update.json"),
  appPath: bundleOf(process.execPath),
  onChange: (s: UpdateState) => {
    views.forEach((v) => v.send.updateState(s));
    showTrayAlert(pluginUpdateAvailable || !!s.available);
  },
  // Start the new version once this one is gone, with its window open (and TOOLBELT_*
  // settings such as a test feed kept), then quit.
  relaunch: (app) => relaunch(app, { ...process.env, TOOLBELT_OPEN_WINDOW: "1" }),
});

// ── plugin development mode (src/bun/development.ts) ────────────────────
const development = new DevelopmentController({
  configRoot,
  profile: developmentProfile,
  archives: localArchives,
  log: developmentLog,
  changed: (state) => views.forEach((v) => v.send.developmentState(state)),
  chooseArchive: async (startingFolder) => {
    const [path] = await Utils.openFileDialog({
      startingFolder: startingFolder ?? "~/",
      allowedFileTypes: "gz",
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: false,
    });
    return path || null;
  },
  // Prepare every running plugin, then relaunch; a refusal reactivates the prepared ones.
  switchMode: async (profile) => {
    const app = bundleOf(process.execPath);
    if (!app) throw new Error("ToolBelt can't find its app bundle to relaunch");
    const phase = updater.state().phase.kind;
    if (phase !== "idle" && phase !== "failed")
      throw new Error("Wait for the app update to finish before switching modes");
    try {
      await prepareForRelaunch("mode-switch");
    } catch (error) {
      await resumeAfterRelaunchFailure();
      throw error;
    }
    localArchives?.closeWatches();
    relaunch(app, {
      ...process.env,
      TOOLBELT_OPEN_WINDOW: "1",
      [DEVELOPMENT_ENV]: profile ?? undefined,
    });
    // Quitting is under way; keep reporting a switch in progress until the process ends.
    await new Promise(() => {});
  },
});
const developmentRequest = (request: DevelopmentRequest) => development.request(request);
function broadcastDevelopment() {
  development.emit();
}

let shortcutError = setHotKey(settings.shortcut, togglePopover);
if (shortcutError) console.error(`shortcut: ${shortcutError}`);

// ── app menu (Edit gives copy/paste/select-all in the web views) ─────────
ApplicationMenu.setApplicationMenu([
  {
    label: variant.name,
    submenu: [
      { label: "About ToolBelt", role: "about" },
      { type: "separator" },
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
      ...(developmentProfile
        ? [{ label: "Return to Normal Mode", action: "exit-development" }]
        : []),
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
  EDIT_MENU as any,
  {
    label: "View",
    submenu: [
      {
        label: "Toggle Sidebar",
        action: "toggle-sidebar",
        accelerator: "CommandOrControl+B",
      },
      {
        label: "Toggle Details",
        action: "toggle-details",
        accelerator: "CommandOrControl+Alt+B",
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
    showWindow("toolbelt", "updates");
    void updater.check();
  }
  if (action === "exit-development")
    void developmentRequest({ operation: "exit" }).then((r) => {
      if (r.error) views.forEach((v) => v.send.toast({ plugin: "toolbelt", text: r.error!, tone: "error" }));
    });
  if (action === "toggle-sidebar")
    winRPC?.send.command({ name: "toggleSidebar" });
  if (action === "toggle-details")
    winRPC?.send.command({ name: "toggleDetails" });
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
Electrobun.events.on("before-quit", () => {
  localArchives?.closeWatches();
  void remoteAccess.stop();
  agents.stop();
  host.stop();
  personViews.flush();
});

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
      if (!localControlRequest(req))
        return new Response("Forbidden origin", { status: 403 });
      const url = new URL(req.url);
      const q = url.searchParams;
      if (url.pathname === "/development") {
        if (req.method !== "POST") return new Response("POST JSON", { status: 405 });
        const request = await req.json().catch(() => null);
        if (!request || typeof request !== "object")
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        return Response.json(await developmentRequest(request as DevelopmentRequest));
      }
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
        development: development.state(),
        remote: remoteAccess.state(),
        profile: profileRoot,
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
// Development profiles start empty: no seed and no scheduled plugin update checks.
if (!developmentProfile)
  void seedDemo().catch((error) => console.error("SDK demo seed:", error));
// Archives the developer chose to watch keep reloading after a relaunch into this profile.
localArchives?.resume();
if (process.env.TOOLBELT_OPEN_WINDOW) showWindow();
updater.start();
manager.start({ scheduledChecks: !developmentProfile });
void remoteAccess.start().catch((error) => console.error("remote access:", error));
void agents.start();
// Wake from sleep: the network takes a moment to come back, then see if a check is due (the
// 15-minute tick would get there too). Noticed as a gap in a once-a-minute heartbeat.
let heartbeat = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - heartbeat > 3 * 60_000)
    setTimeout(() => updater.checkIfDue(undefined, "wake"), 20_000);
  heartbeat = now;
  if (trayAlert) showTrayAlert(true); // the menu bar may have changed shade
}, 60_000);
console.log(
  `ToolBelt ${pkg.version} (${channel}${developmentProfile ? `, development profile ${developmentProfile}` : ""}) — plugins: ${
    host
      .list()
      .map((p) => p.manifest.id)
      .join(", ") || "none"
  }`,
);
