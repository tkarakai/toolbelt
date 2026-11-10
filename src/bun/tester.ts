import { localControlRequest } from "./loopback";
import { prepareAppHandoff } from "./activation";
import { PluginManagerService } from "./plugin-manager-service";
import Electrobun, {
  ApplicationMenu,
  Screen,
  BrowserView,
  BrowserWindow,
  Utils,
} from "electrobun/main";
import { EDIT_MENU } from "./edit-menu";
import { dirname, basename } from "node:path";
import { TesterRuntime, testerProfile } from "./tester-runtime";
import { DEFAULTS, loadSettings, saveSettings } from "./settings";
import { pluginAsset } from "./plugin-assets";
import { FileIcons } from "./file-icon";
import { createNativePopover, positionPopover } from "./native-popover";
import { setTrayHighlighted } from "./tray-highlight";
import pkg from "../../package.json";
const root = testerProfile(process.env.TOOLBELT_TESTER_PROFILE);
process.env.TOOLBELT_CONFIG_DIR = root;
const runtime = new TesterRuntime(root, pkg.version);
const profileQuery =
  "?profile=" +
  new Bun.CryptoHasher("sha256").update(root).digest("hex").slice(0, 24);
let settings = loadSettings({ ...DEFAULTS, shortcut: "" });
const icons = new FileIcons(root + "/cache/icons");
const manager = new PluginManagerService(runtime.packages, runtime.host);
let unwatch: (() => void) | undefined;
const views = new Set<any>();
const reports = new Map<number, (value: unknown) => void>();
let reportId = 0;
let native: ReturnType<typeof createNativePopover> | undefined;
let nativeShownAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const broadcast = (name: string, payload: unknown) =>
  views.forEach((view) => view.send[name](payload));
ApplicationMenu.setApplicationMenu([
  {
    label: "Toolbelt Plugin Tester",
    submenu: [
      {
        label: "Settings…",
        accelerator: "CommandOrControl+,",
        action: "settings",
      },
      {
        label: "Quit",
        accelerator: "CommandOrControl+Q",
        action: "tester-quit",
      },
    ],
  },
  EDIT_MENU,
  {
    label: "View",
    submenu: [
      { label: "Zoom in", accelerator: "CommandOrControl+=", action: "zoomIn" },
      {
        label: "Zoom out",
        accelerator: "CommandOrControl+-",
        action: "zoomOut",
      },
      {
        label: "Actual size",
        accelerator: "CommandOrControl+0",
        action: "zoomReset",
      },
    ],
  },
] as any);
async function evalIn(js: string, target = "window") {
  const view = target === "popover" ? native?.popover.webview : win.webview;
  if (!view) return { error: "No native popover" };
  const id = ++reportId;
  return new Promise((resolve) => {
    reports.set(id, resolve);
    view.executeJavascript(
      `Promise.resolve().then(()=>(${js})).then(v=>window.__tbReport(${id},v),e=>window.__tbReport(${id},{error:String(e)}))`,
    );
    setTimeout(() => {
      if (reports.has(id)) {
        reports.delete(id);
        resolve({ error: "timeout" });
      }
    }, 10000);
  });
}
export async function testerControl(
  operation: string,
  p: Record<string, any> = {},
) {
  switch (operation) {
    case "activateMain":
      win.show();
      win.activate();
      return true;
    case "viewport": {
      const frame = win.getFrame();
      win.setFrame(
        frame.x,
        frame.y,
        Math.max(320, Math.min(1600, Number(p.width))),
        frame.height,
      );
      return true;
    }
    case "load":
      await runtime.load(p.archive, p.repo, p.approved === true);
      return true;
    case "watch":
      if (p.approved !== true)
        throw new Error("Explicit execution approval required");
      unwatch?.();
      unwatch = runtime.watchArchive(
        dirname(p.archive),
        basename(p.archive),
        p.repo,
      );
      return true;
    case "unwatch":
      unwatch?.();
      unwatch = undefined;
      return true;
    case "diagnostics":
      return runtime.diagnostics;
    case "reset":
      await runtime.reset(p.id);
      return true;
    case "nativePopover": {
      if (!native) {
        native = createNativePopover({
          title: "Toolbelt Plugin Tester",
          url: "views://ui/index.html" + profileQuery + "#popover",
          image: "views://assets/tray-icon-dev@2x.png",
          template: false,
          rpc: makeRPC(),
        });
        native.tray.on("tray-clicked", () => {
          if (native!.popover.isVisible()) hideNative();
          else showNative();
        });
        native.popover.on("blur", () => {
          if (Date.now() - nativeShownAt > 150) hideNative();
        });
      }
      showNative();
      return true;
    }
    default:
      throw new Error("Unknown tester operation");
  }
}
function showNative() {
  if (!native) return;
  clearTimeout(hideTimer);
  nativeShownAt = Date.now();
  const { x, y } = positionPopover(native.tray);
  native.popover.setFrame(x, y, 380, 520);
  native.popover.show();
  native.popover.activate();
  setTrayHighlighted(true);
  broadcast("popoverShown", {});
}
function hideNative() {
  if (!native?.popover.isVisible()) return;
  setTrayHighlighted(false);
  broadcast("popoverHiding", {});
  hideTimer = setTimeout(() => native?.popover.hide(), 160);
}
function makeRPC() {
  const rpc: any = BrowserView.defineRPC({
    maxRequestTime: 300000,
    handlers: {
      requests: {
        tester: ({ operation, ...params }: any) =>
          testerControl(operation, params),
        plugins: () => runtime.host.list(),
        open: (p: any) => runtime.host.open(p.plugin, p.surface),
        close: (p: any) => {
          runtime.host.close(p.plugin, p.surface);
          return true;
        },
        event: async (p: any) => {
          if (
            runtime.host
              .list()
              .find((plugin) => plugin.manifest.id === p.plugin)
              ?.manifest.handoffActions?.includes(p.name)
          ) {
            await win.activate();
            prepareAppHandoff();
          }
          runtime.record("event", p);
          runtime.host.event(p.plugin, p.surface, p.name, p.payload);
          return true;
        },
        restartPlugin: async (p: any) => {
          try {
            await runtime.host.restart(p.plugin);
          } catch (error) {
            broadcast("toast", {
              plugin: p.plugin,
              text: String(error),
              tone: "error",
            });
            throw error;
          }
          return true;
        },
        settings: () => ({
          ...settings,
          shortcutLabel: "None (tester)",
          shortcutError: null,
        }),
        setAppearance: (p: any) => {
          settings = { ...settings, ...p };
          saveSettings(settings);
          broadcast("settingsChanged", {});
          return true;
        },
        setShortcut: () => ({
          ok: false,
          error: "Global shortcuts disabled in tester",
        }),
        pauseShortcut: () => true,
        fileIcon: (p: any) => icons.get(p.path),
        pluginAsset: (p: any) => pluginAsset(runtime.packages, p.reference),
        pluginManager: (p: any) => manager.handle(p),
        openUrl: (p: any) =>
          /^(https?:|mailto:)/i.test(p.url) && Utils.openExternal(p.url),
        updateState: () => ({
          enabled: false,
          version: pkg.version,
          checking: false,
          lastChecked: null,
          nextCheck: null,
          lastError: null,
          latest: null,
          phase: { kind: "idle" },
          available: null,
          channel: "tester",
          appPath: null,
        }),
        checkForUpdates: () => true,
        installUpdate: () => true,
        cancelUpdate: () => true,
        dismissUpdate: () => true,
      },
      messages: {
        showWindow: (p: any) => {
          hideNative();
          win.show();
          win.activate();
          broadcast("navigate", p);
        },
        hidePopover: hideNative,
        popoverSize: (p: any) => {
          if (native) {
            const f = native.popover.getFrame();
            native.popover.setFrame(
              f.x,
              f.y,
              380,
              p.height === null ? 520 : Math.max(120, Math.min(520, p.height)),
            );
          }
        },
        closeWindow: () => win.close(),
        zoomWindow: () => {
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
        },
        debugReport: ({ id, value }: any) => {
          reports.get(id)?.(value);
          reports.delete(id);
        },
        quit: () => win.close(),
      },
    },
  } as any);
  views.add(rpc);
  return rpc;
}
manager.subscribe((state) => broadcast("pluginManagerState", state));
runtime.host.subscribe({
  plugins: (list) => broadcast("plugins", list),
  tree: (plugin, surface, tree) => broadcast("tree", { plugin, surface, tree }),
  toast: (plugin, text, tone, action) =>
    broadcast("toast", { plugin, text, tone, action }),
});
await runtime.start();
const win = new BrowserWindow({
  title: "Toolbelt Plugin Tester",
  url: "views://ui/index.html" + profileQuery,
  frame: { x: 120, y: 120, width: 1280, height: 900 },
  rpc: makeRPC(),
});
win.on("close", () => {
  unwatch?.();
  void runtime.stop().finally(() => process.exit(0));
});
if (process.env.TOOLBELT_DEBUG_PORT)
  Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.TOOLBELT_DEBUG_PORT),
    async fetch(req) {
      if (!localControlRequest(req))
        return new Response("Forbidden origin", { status: 403 });
      const url = new URL(req.url);
      try {
        if (url.pathname === "/state")
          return Response.json({
            pid: process.pid,
            root,
            plugins: runtime.host.list(),
            diagnostics: runtime.diagnostics,
            native: native
              ? {
                  visible: native.popover.isVisible(),
                  frame: native.popover.getFrame(),
                  trayBounds: native.tray.getBounds(),
                  display: Screen.getPrimaryDisplay(),
                }
              : null,
          });
        if (url.pathname === "/eval" && req.method === "POST")
          return Response.json(
            await evalIn(
              await req.text(),
              url.searchParams.get("target") ?? "window",
            ),
          );
        if (url.pathname === "/control" && req.method === "POST") {
          const { operation, ...params } = await req.json();
          return Response.json(await testerControl(operation, params));
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    },
  });

Electrobun.events.on("application-menu-clicked", (event: any) => {
  const action = String(event.data.action ?? "");
  if (action === "tester-quit") win.close();
  else if (action === "settings") broadcast("navigate", { plugin: "toolbelt" });
  else broadcast("command", { name: action });
});
