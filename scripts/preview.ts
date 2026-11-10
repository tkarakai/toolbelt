#!/usr/bin/env bun
import { localControlRequest } from "../src/bun/loopback";
// Toolbelt's UI in a plain browser, with the real plugins: serves dist/ (run `bun run views`
// first) and bridges the web view RPC over a WebSocket. For designing and screenshotting the
// UI without the app. Run: bun scripts/preview.ts  →  http://localhost:5174 (#popover too)
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { PluginHost, configDir } from "../src/bun/host";
import { PackageManager } from "../src/bun/packages";
import { PluginManagerService } from "../src/bun/plugin-manager-service";
import { pluginAsset } from "../src/bun/plugin-assets";
import type { ServerWebSocket } from "bun";
import { DEFAULTS, type Settings } from "../src/bun/settings";
import { displayAccelerator } from "../src/bun/hotkey";
import { FileIcons } from "../src/bun/file-icon";
import type { Phase, UpdateState } from "../src/bun/updater";

// Settings live in memory here (the preview doesn't touch the app's settings file).
let settings: Settings = { ...DEFAULTS };

process.env.TOOLBELT_CONFIG_DIR ??= join(
  homedir(),
  "Library/Application Support/Toolbelt Preview V2",
);
const port = Number(process.env.PORT ?? 5174);
const host = new PluginHost({
  dirs: [],
  registryRoot: configDir(homedir()),
  bun: process.execPath,
  host: { name: "Toolbelt preview", version: "0.1.0" },
  data: join(configDir(homedir()), "data"),
});
const packages = new PackageManager(configDir(homedir()), {
  prepare: (id, reason) => host.prepare(id, reason),
  stop: (id) => host.stopPlugin(id),
  probe: (candidate, data) => host.probe(candidate, data),
  activate: (p) => host.activate(p),
  remove: (id) => host.remove(id),
});
await packages.recover();
const manager = new PluginManagerService(packages, host);

const icons = new FileIcons(join(configDir(homedir()), "cache/icons"));
const clients = new Set<ServerWebSocket<{ opened: Set<string> }>>();
const broadcast = (name: string, payload: unknown) =>
  clients.forEach((c) =>
    c.send(JSON.stringify({ kind: "message", name, payload })),
  );
host.subscribe({
  plugins: (list) => broadcast("plugins", list),
  tree: (plugin, surface, tree) => broadcast("tree", { plugin, surface, tree }),
  toast: (plugin, text, tone, action) =>
    broadcast("toast", { plugin, text, tone, action }),
  clipboard: (_plugin, text) => {
    const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    p.stdin.write(text);
    p.stdin.end();
  },
});
host.start();
manager.start();
manager.subscribe((state) => broadcast("pluginManagerState", state));

// A pretend update, to design the Updates card and dialog: a newer release is "available";
// Update runs through the phases on a timer. GET /update?phase=failed (downloading, verifying,
// installing, relaunching, idle) or /update?available=0 sets the state directly.
const release = {
  version: "0.2.0",
  notes:
    "### Added\n\n- Toolbelt updates itself: a red dot on the menu bar icon when a new version is out, and **Update** on Toolbelt's page.\n- *Check for Updates…* in the app menu.\n\n### Fixed\n\n- The popover remembers the last tool.",
  page: "https://github.com/tkarakai/toolbelt/releases",
  dmg: "",
  size: 34_600_000,
  sha256: null,
  published: Date.now() - 2 * 86_400_000,
};
let update: UpdateState = {
  enabled: true,
  channel: "stable",
  version: "0.1.0",
  checking: false,
  lastChecked: Date.now() - 12 * 60_000,
  nextCheck: Date.now() + 5 * 3_600_000,
  lastError: null,
  latest: release,
  available: release,
  phase: { kind: "idle" },
  appPath: "/Applications/Toolbelt.app",
};
let sim: ReturnType<typeof setInterval> | null = null;
const setUpdate = (u: Partial<UpdateState>) =>
  broadcast("updateState", (update = { ...update, ...u }));
const setPhase = (phase: Phase) => setUpdate({ phase });
function simulate() {
  let got = 0;
  sim && clearInterval(sim);
  sim = setInterval(() => {
    got += 1_900_000;
    if (got < release.size)
      return setPhase({
        kind: "downloading",
        received: got,
        total: release.size,
        speed: 9_500_000,
      });
    clearInterval(sim!);
    setPhase({ kind: "verifying" });
    setTimeout(() => setPhase({ kind: "installing" }), 1500);
    setTimeout(() => setPhase({ kind: "relaunching" }), 3000);
    setTimeout(
      () =>
        setUpdate({
          phase: { kind: "idle" },
          version: release.version,
          available: null,
        }),
      5000,
    );
  }, 200);
}

Bun.serve<{ opened: Set<string> }>({
  port,
  hostname: "127.0.0.1",
  fetch(req, server) {
    if (!localControlRequest(req))
      return new Response("Forbidden origin", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/rpc")
      return server.upgrade(req, { data: { opened: new Set() } })
        ? undefined
        : new Response("no", { status: 400 });
    if (url.pathname === "/update") {
      const q = url.searchParams;
      const kind = q.get("phase");
      if (kind === "failed")
        setPhase({
          kind,
          message: "The download is damaged (checksum mismatch). Try again.",
        });
      else if (kind === "downloading")
        setPhase({
          kind,
          received: 12_400_000,
          total: release.size,
          speed: 8_300_000,
        });
      else if (kind) setPhase({ kind } as Phase);
      if (q.has("available"))
        setUpdate({
          available: q.get("available") === "0" ? null : release,
          version: q.get("available") === "0" ? release.version : "0.1.0",
        });
      if (q.has("error")) setUpdate({ lastError: q.get("error") || null });
      if (q.has("channel"))
        setUpdate({
          channel: q.get("channel")!,
          enabled: q.get("channel") === "stable",
        });
      return Response.json(update);
    }
    const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = Bun.file(join("dist", path));
    return file.size
      ? new Response(file)
      : new Response("not found", { status: 404 });
  },
  websocket: {
    open: (ws) => void clients.add(ws),
    close: (ws) => {
      clients.delete(ws);
      for (const k of ws.data.opened)
        host.close(...(k.split("\n") as [string, string]));
    },
    async message(ws, raw) {
      const m = JSON.parse(String(raw));
      if (m.kind !== "request") return;
      const p = m.params ?? {};
      const reply = (result: unknown) =>
        ws.send(JSON.stringify({ kind: "response", id: m.id, result }));
      try {
        switch (m.method) {
          case "pluginAsset":
            return reply(pluginAsset(packages, p.reference));
          case "pluginManager":
            return reply(await manager.handle(p));
          case "plugins":
            return reply(host.list());
          case "open":
            ws.data.opened.add(`${p.plugin}\n${p.surface}`);
            return reply(host.open(p.plugin, p.surface));
          case "close":
            ws.data.opened.delete(`${p.plugin}\n${p.surface}`);
            host.close(p.plugin, p.surface);
            return reply(true);
          case "event":
            host.event(p.plugin, p.surface, p.name, p.payload);
            return reply(true);
          case "restartPlugin":
            await host.restart(p.plugin);
            return reply(true);
          case "settings":
            return reply({
              ...settings,
              shortcutLabel: displayAccelerator(settings.shortcut),
              shortcutError: null,
            });
          case "setAppearance":
            settings = {
              ...settings,
              ...(p.theme ? { theme: p.theme } : {}),
              ...(p.mode ? { mode: p.mode } : {}),
            };
            broadcast("settingsChanged", {});
            return reply(true);
          case "setShortcut":
            settings = { ...settings, shortcut: p.accelerator };
            broadcast("settingsChanged", {});
            return reply({
              ok: true,
              label: displayAccelerator(p.accelerator),
            });
          case "pauseShortcut":
            return reply(true);
          case "fileIcon":
            return void icons.get(p.path).then(reply);
          case "openUrl":
            return reply(false); // the browser opens links itself
          case "updateState":
            return reply(update);
          case "checkForUpdates":
            setUpdate({ checking: true });
            setTimeout(
              () => setUpdate({ checking: false, lastChecked: Date.now() }),
              1200,
            );
            return reply(true);
          case "installUpdate":
            simulate();
            return reply(true);
          case "cancelUpdate":
            sim && clearInterval(sim);
            setPhase({ kind: "idle" });
            return reply(true);
          case "dismissUpdate":
            setPhase({ kind: "idle" });
            return reply(true);
        }
      } catch (e) {
        ws.send(
          JSON.stringify({
            kind: "response",
            id: m.id,
            error: (e as Error).message,
          }),
        );
      }
    },
  },
});
console.log(
  `Toolbelt preview: http://localhost:${port}  (popover: http://localhost:${port}/#popover)`,
);
process.on("SIGINT", () => (host.stop(), process.exit(0)));
