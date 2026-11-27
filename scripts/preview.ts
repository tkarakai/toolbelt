#!/usr/bin/env bun
import pkg from "../package.json";
import { localControlRequest } from "../src/bun/loopback";
// Toolbelt's UI in a plain browser, with the real plugins: serves dist/ (run `bun run views`
// first) and bridges the web view RPC over a WebSocket. For designing and screenshotting the
// UI without the app. Run: bun scripts/preview.ts  →  http://localhost:5174 (#popover too)
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginHost, configDir } from "../src/bun/host";
import { PackageManager } from "../src/bun/packages";
import { PluginManagerService } from "../src/bun/plugin-manager-service";
import { pluginAsset } from "../src/bun/plugin-assets";
import { buildIdOf, startRemoteServer, type RemoteClient } from "../src/bun/remote-server";
import type { ToolbeltRPC } from "../src/shared/rpc";
import { RemoteAccess } from "../src/bun/remote-access";
import { deviceName } from "../src/bun/pairing";
import { REMOTE_CLOSE } from "../src/shared/remote";
import type { Runner } from "../src/bun/tailscale";
import { DEFAULTS, type Settings } from "../src/bun/settings";
import { displayAccelerator } from "../src/bun/hotkey";
import { FileIcons } from "../src/bun/file-icon";
import type { Phase, UpdateState } from "../src/bun/updater";
import { githubMetadata } from "../src/bun/github-metadata";
import { mkdirSync } from "node:fs";
import { createAgentInterface, declaredAccess } from "../src/bun/agent";
import { ViewStore } from "../src/bun/views";
import { KeychainBackend, MemorySecretBackend, SecretStore, profileKey } from "../src/bun/secrets";
import { cleanView } from "../src/shared/views";
import { PERSON } from "../src/shared/protocol";
import {
  DEVELOPMENT_ENV,
  DevelopmentController,
  DiagnosticLog,
  LocalArchives,
  developmentProfileName,
  developmentRoot,
} from "../src/bun/development";

// Settings live in memory here (the preview doesn't touch the app's settings file).
// The preview's pretend remote access listens away from the app's port.
// PREVIEW_AGENTS=1 starts with the agent interface on (docs/agent-interface.md).
let settings: Settings = {
  ...DEFAULTS,
  remote: { ...DEFAULTS.remote, port: Number(process.env.REMOTE_PORT ?? 47389) },
  agents: { ...DEFAULTS.agents, enabled: process.env.PREVIEW_AGENTS === "1" },
};

process.env.TOOLBELT_CONFIG_DIR ??= join(
  homedir(),
  "Library/Application Support/Toolbelt Preview V2",
);
const port = Number(process.env.PORT ?? 5174);
// TOOLBELT_DEVELOPMENT_PROFILE runs the preview on a development profile with local archives.
// Mode switches relaunch the app, so the preview only reports them.
const developmentProfile = process.env[DEVELOPMENT_ENV]
  ? developmentProfileName(process.env[DEVELOPMENT_ENV])
  : null;
const root = developmentProfile
  ? developmentRoot(configDir(homedir()), developmentProfile)
  : configDir(homedir());
mkdirSync(root, { recursive: true });
const developmentLog = new DiagnosticLog();
const personViews = new ViewStore(join(root, "views.json"));
// Set once the agent interface exists (below); plugins started before that don't get it.
let agentCommand: string[] | null = null;
// Plugin secrets stay in memory unless PREVIEW_KEYCHAIN=1, which uses the login Keychain under
// this preview profile's own services (never the app's).
const secrets = new SecretStore(
  process.env.PREVIEW_KEYCHAIN === "1" ? new KeychainBackend() : new MemorySecretBackend(),
  profileKey(root, configDir(homedir(), {})),
);
const host = new PluginHost({
  agentCommand: () => agentCommand,
  secrets,
  dirs: [],
  registryRoot: root,
  bun: process.execPath,
  host: { name: "Toolbelt preview", version: pkg.version },
  data: join(root, "data"),
  views: personViews,
  diagnostic: (plugin, kind, detail) => developmentLog.record(kind, { plugin, detail }),
});
const packages = new PackageManager(
  root,
  {
    prepare: (id, reason) => host.prepare(id, reason),
    stop: (id) => host.stopPlugin(id),
    probe: (candidate, data) => host.probe(candidate, data),
    activate: (p) => host.activate(p),
    remove: (id) => host.remove(id),
    deleteSecrets: (p) => host.deleteSecrets({ id: p.id, name: p.manifest.name, repo: p.repo }),
  },
  pkg.version,
  undefined,
  undefined,
  !!developmentProfile,
);
await packages.recover();
const manager = new PluginManagerService(packages, host);
// The agent interface, as the app has it; its socket lives in the preview's config folder.
const agents = createAgentInterface({
  host,
  settings: () => settings.agents,
  save: (next) => {
    settings = { ...settings, agents: next };
  },
  app: () => ({ name: "Toolbelt preview", version: pkg.version, channel: "preview", developmentProfile, location: join(import.meta.dir, "..") }),
  appUpdate: () => ({ available: update.available?.version ?? null, lastChecked: update.lastChecked }),
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
  configRoot: configDir(homedir()),
  profileRoot: root,
  cliScript: join(import.meta.dir, "../src/cli/toolbelt.ts"),
  bun: process.execPath,
  changed: (state) => broadcast("agentsState", state),
  // The preview's browser tabs stand in for the person's screens.
  person: {
    devices: () => [{ name: "the browser preview", kind: "mac" as const, showing: true }],
    openWindow: () => {},
    navigate: (plugin, screen) => broadcast("navigate", { plugin, screen }),
    view: (plugin, surface) => host.personView(plugin, surface),
    setView: (plugin, surface, view) => {
      const clean = cleanView(host.declaredView(plugin, surface) ?? undefined, view);
      if ((host.snapshot(plugin, surface, PERSON)?.viewers ?? 0) > 0) host.setView(plugin, surface, PERSON, clean);
      else personViews.save(plugin, surface, clean);
    },
  },
});
agentCommand = agents.command;

const icons = new FileIcons(join(root, "cache/icons"));
// Replaced by the server's broadcast once it listens.
let broadcast: (name: string, payload: unknown) => void = () => {};
const localArchives = developmentProfile
  ? new LocalArchives(packages, developmentLog, () => development.emit())
  : null;
const development = new DevelopmentController({
  configRoot: configDir(homedir()),
  profile: developmentProfile,
  archives: localArchives,
  log: developmentLog,
  changed: (state) => broadcast("developmentState", state),
  switchMode: async (profile) => {
    throw new Error(
      `The browser preview can't relaunch. Restart it ${profile ? `with ${DEVELOPMENT_ENV}=${profile}` : `without ${DEVELOPMENT_ENV}`}.`,
    );
  },
});
host.subscribe({
  plugins: (list) => broadcast("plugins", list),
  tree: (plugin, surface, tree, instance) => {
    if (instance === PERSON) broadcast("tree", { plugin, surface, tree });
  },
  toast: (plugin, text, tone, action) =>
    broadcast("toast", { plugin, text, tone, action }),
  clipboard: (_plugin, text) => {
    const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    p.stdin.write(text);
    p.stdin.end();
  },
  navigate: (plugin, screen, select) =>
    broadcast("navigate", {
      plugin,
      screen,
      selection: select ? { item: select } : undefined,
    }),
});
host.start();
manager.start({ scheduledChecks: !developmentProfile });
localArchives?.resume();
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
  githubHistory: githubMetadata(join(configDir(homedir()), "cache/github-metadata.json")).history(),
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

// A pretend Tailscale for the Remote Access tab: never runs the real CLI. GET
// /remote?scenario=ok|missing|stopped|nohttps|conflict picks what it reports.
let tailscaleScenario = "ok";
const fakeRules = new Map<number, string>();
const fakeTailscale: Runner = async (_cli, args) => {
  const ok = (stdout: unknown) => ({ code: 0, stderr: "", stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout) });
  if (tailscaleScenario === "stopped") return { code: 1, stdout: "", stderr: "Tailscale is stopped." };
  if (args[0] === "status")
    return ok({
      BackendState: "Running",
      Self: { DNSName: "macbook.example-tailnet.ts.net.", UserID: 1, OS: "macOS", TailscaleIPs: ["100.64.0.1"], CapMap: tailscaleScenario === "nohttps" ? {} : { https: null } },
      Peer: {
        a: { DNSName: "iphone.example-tailnet.ts.net.", OS: "iOS", TailscaleIPs: ["100.64.0.2"], CurAddr: "203.0.113.4:41641" },
        b: { DNSName: "ipad.example-tailnet.ts.net.", OS: "iOS", TailscaleIPs: ["100.64.0.3"], Relay: "fra" },
      },
      User: { "1": { LoginName: "owner@example.com" } },
    });
  if (args.join(" ") === "serve status --json") {
    const rules = new Map(fakeRules);
    if (tailscaleScenario === "conflict") rules.set(settings.remote.port, "http://127.0.0.1:3000");
    return ok({
      TCP: Object.fromEntries([...rules.keys()].map((p) => [p, { HTTPS: true }])),
      Web: Object.fromEntries([...rules].map(([p, target]) => [`macbook.example-tailnet.ts.net:${p}`, { Handlers: { "/": { Proxy: target } } }])),
    });
  }
  const httpsPort = Number(args.find((a) => a.startsWith("--https="))?.slice(8));
  if (args.at(-1) === "off") fakeRules.delete(httpsPort);
  else fakeRules.set(httpsPort, args.at(-1)!);
  return ok("");
};
const remoteAccess: RemoteAccess = new RemoteAccess({
  settings: () => settings.remote,
  devicesFile: join(process.env.TOOLBELT_CONFIG_DIR!, "remote-devices.json"),
  save: (remote) => {
    settings = { ...settings, remote };
    broadcast("settingsChanged", {});
  },
  root: "dist",
  handlers: { request: () => { throw new Error("The preview's remote server serves no RPC"); } },
  changed: (state) => broadcast("remoteAccessState", state),
  findCli: () => (tailscaleScenario === "missing" ? null : "/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
  runner: fakeTailscale,
  // The pretend ts.net address answers for the preview's own remote server.
  fetch: async (): Promise<Response> => Response.json({ instance: remoteAccess.instance }),
});
async function remoteRoute(url: URL): Promise<Response> {
  // /remote?pairing=start shows a pairing code (and returns it) without a paired view.
  if (url.searchParams.get("pairing") === "start") {
    const state = await remoteAccess.handle({ operation: "startPairing" });
    return Response.json(state.pairing);
  }
  const scenario = url.searchParams.get("scenario");
  if (scenario) tailscaleScenario = scenario;
  void remoteAccess.handle({ operation: "refresh" });
  return Response.json({ scenario: tailscaleScenario });
}

// PREVIEW_REQUIRE_PAIRING=1: this preview's own connections must pair, as remote devices do,
// against the pretend remote access's paired devices (docs/remote-access.md, "Pairing").
const previewPairing = process.env.PREVIEW_REQUIRE_PAIRING === "1"
  ? {
      verify: (token: unknown) => remoteAccess.registry.verify(token),
      pair: (secret: unknown, label: unknown) => {
        const result = remoteAccess.registry.pair(secret, deviceName("preview", label));
        void remoteAccess.handle({ operation: "read" });
        return result;
      },
    }
  : undefined;

// The update simulation's controls: GET /update?phase=… (see above).
function updateRoute(url: URL): Response {
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
  if (q.has("recovery")) {
    const kind = q.get("recovery") as "quota" | "throttled" | "missing" | "network" | "service";
    const message = kind === "quota" ? "GitHub’s request quota is exhausted." : kind === "throttled" ? "GitHub is temporarily slowing requests." : kind === "missing" ? "No public release was found for this channel." : kind === "network" ? "Couldn’t connect to GitHub. Check your connection and try again." : "GitHub’s release service is having trouble.";
    const retryAt = kind === "quota" || kind === "throttled" ? Date.now()+12*60000 : undefined;
    setUpdate({lastError:message, failure:{kind, message, retryAt, retrySource:retryAt ? "quota-reset" : undefined, at:Date.now(), status:kind === "quota" ? 403 : kind === "throttled" ? 429 : kind === "missing" ? 404 : kind === "service" ? 503 : undefined}, retryAt});
  }
  if (q.has("channel"))
    setUpdate({
      channel: q.get("channel")!,
      enabled: q.get("channel") === "stable",
    });
  return Response.json(update);
}

// Request handlers, as the app's main process has them (minus the native popover's geometry);
// the type makes a method the RPC gains fail typecheck here. Unknown methods fail closed.
type Requests = ToolbeltRPC["bun"]["requests"];
const handlers: { [K in Exclude<keyof Requests, "popoverLayout">]: (p: Requests[K]["params"], client: RemoteClient) => unknown } = {
  pluginAsset: (p) => pluginAsset(packages, p.reference),
  pluginManager: (p) => manager.handle(p),
  initialNavigation: () => null,
  plugins: () => host.list(),
  // One viewer count per connection and surface, however often it opens or closes (as the app).
  open: (p, client) => {
    const key = `${p.plugin}\n${p.surface}`;
    if (client.opened.has(key)) return host.tree(p.plugin, p.surface);
    client.opened.add(key);
    return host.open(p.plugin, p.surface);
  },
  close: (p, client) => {
    if (client.opened.delete(`${p.plugin}\n${p.surface}`)) host.close(p.plugin, p.surface);
    return true;
  },
  event: (p) => (host.event(p.plugin, p.surface, p.name, p.payload), true),
  restartPlugin: async (p) => (await host.restart(p.plugin), true),
  settings: () => ({
    ...settings,
    shortcutLabel: displayAccelerator(settings.shortcut),
    shortcutError: null,
    badgePlugins: settings.remote.badgePlugins,
  }),
  setAppearance: (p) => {
    settings = {
      ...settings,
      ...(p.theme ? { theme: p.theme } : {}),
      ...(p.mode ? { mode: p.mode as Settings["mode"] } : {}),
    };
    broadcast("settingsChanged", {});
    return true;
  },
  setShortcut: (p) => {
    settings = { ...settings, shortcut: p.accelerator };
    broadcast("settingsChanged", {});
    return { ok: true, label: displayAccelerator(p.accelerator) };
  },
  pauseShortcut: () => true,
  fileIcon: (p) => icons.get(p.path),
  openUrl: () => false, // the browser opens links itself
  development: (p) => development.request(p),
  remoteAccess: async (p) => {
    const state = await remoteAccess.handle(p);
    // With PREVIEW_REQUIRE_PAIRING, removing a device also ends this preview's connections for it.
    if (p.operation === "revoke" && !state.lastError)
      for (const client of server.clients) if (client.device?.id === p.id) client.close(REMOTE_CLOSE.revoked, "Pairing removed");
    return state;
  },
  agents: (p) => agents.handle(p),
  buildId: () => buildIdOf("dist"),
  updateState: () => update,
  checkForUpdates: () => {
    setUpdate({ checking: true });
    setTimeout(
      () => setUpdate({ checking: false, lastChecked: Date.now() }),
      1200,
    );
    return true;
  },
  installUpdate: () => (simulate(), true),
  cancelUpdate: () => {
    sim && clearInterval(sim);
    setPhase({ kind: "idle" });
    return true;
  },
  dismissUpdate: () => (setPhase({ kind: "idle" }), true),
};

const server = startRemoteServer({
  port,
  root: "dist",
  pairing: previewPairing,
  check: (req, peer) =>
    localControlRequest(req) && (peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1")
      ? { ok: true, ip: null }
      : { ok: false, status: 403, reason: "Forbidden origin" },
  route: (_req, url) => {
    if (url.pathname === "/update") return updateRoute(url);
    if (url.pathname === "/remote") return remoteRoute(url);
    // The app bundle copies the home-screen icons; the preview serves them from assets/.
    const icon = url.pathname.match(/^\/pwa\/icon-(180|192|512)\.png$/)?.[1];
    if (icon) return new Response(Bun.file(`assets/web-app-icon-${icon}.png`), { headers: { "content-type": "image/png" } });
  },
  request: (client, method, params) => {
    const handler = (handlers as Record<string, ((p: unknown, c: RemoteClient) => unknown) | undefined>)[method];
    if (!handler) throw new Error(`Unknown method ${method}`);
    return handler(params, client);
  },
  message: (_client, name, payload) => {
    if (name === "selectionChanged") broadcast("selectionChanged", payload);
  },
  closed: (client) => {
    for (const k of client.opened) host.close(...(k.split("\n") as [string, string]));
  },
});
broadcast = server.broadcast;
void agents.start();
console.log(
  `Toolbelt preview: http://localhost:${port}  (popover: http://localhost:${port}/#popover)`,
);
process.on("SIGINT", () => (agents.stop(), host.stop(), process.exit(0)));
process.on("SIGTERM", () => (agents.stop(), host.stop(), process.exit(0)));
