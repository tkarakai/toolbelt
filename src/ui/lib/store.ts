import { GitHubError } from "../../shared/github";
import type { NavigationSelection } from "../../shared/navigation";
import { useOrderedPlugins } from "./plugin-order";
// The web side of Toolbelt: one RPC connection to the main process, and a tiny store of what
// it sent (plugins, UI trees) that React reads with useSyncExternalStore.
import { Electroview } from "electrobun/view";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { showPluginToast } from "./plugin-toast";
import { inApp } from "./device";
import { createSocketTransport, type ConnectionStatus } from "./connection";
import { deviceLabel, installContext } from "./install";
import type { RemoteAccessRequest, RemoteAccessState } from "../../shared/remote";
import type { Node } from "../../shared/protocol";
import type { PluginInfo, ToolbeltRPC, UpdateState } from "../../shared/rpc";
import {
  UNAVAILABLE_DEVELOPMENT,
  type DevelopmentRequest,
  type DevelopmentResponse,
  type DevelopmentState,
} from "../../shared/development";

/** `pluginsKnown`: the host has sent the plugin list (an empty list means none installed). */
type State = { plugins: PluginInfo[]; pluginsKnown: boolean; trees: Record<string, Node> };
let state: State = { plugins: [], pluginsKnown: false, trees: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next, ...(next.plugins ? { pluginsKnown: true } : {}) };
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

type NavListener = (plugin: string, screen?: string, selection?: NavigationSelection) => void;
const navListeners = new Set<NavListener>();
const shownListeners = new Set<() => void>();
const hidingListeners = new Set<() => void>();
const settingsListeners = new Set<() => void>();
const commandListeners = new Set<(name: string) => void>();
export const selectionListeners = new Set<(payload: { plugin: string; selection: NavigationSelection | null; at?: number }) => void>();
/** Pushed update states (src/ui/Updates.tsx subscribes). */
export const updateListeners = new Set<(s: UpdateState) => void>();

/** App-menu commands sent to this window (toggleSidebar…). */
export function useCommand(fn: (name: string) => void) {
  useEffect(() => {
    commandListeners.add(fn);
    return () => void commandListeners.delete(fn);
  }, [fn]);
}

export const pluginManagerListeners = new Set<
  (state: Messages["pluginManagerState"]) => void
>();
const handlers: { [K in keyof Messages]: (p: Messages[K]) => void } = {
  plugins: (plugins) => {
    const active = new Map(
      plugins.map((p) => [p.manifest.id, p.manifest.version]),
    );
    const previous = new Map(
      state.plugins.map((p) => [p.manifest.id, p.manifest.version]),
    );
    const trees = Object.fromEntries(
      Object.entries(state.trees).filter(([key]) => {
        const id = key.split("\n")[0]!;
        return active.has(id) && active.get(id) === previous.get(id);
      }),
    );
    set({ plugins, trees });
  },
  selectionChanged: payload => selectionListeners.forEach(listener => listener(payload)),
  pluginManagerState: (state) =>
    pluginManagerListeners.forEach((listener) => listener(state)),
  tree: ({ plugin, surface, tree }) => {
    arrived.set(key(plugin, surface), performance.now());
    set({ trees: { ...state.trees, [key(plugin, surface)]: tree } });
  },
  toast: ({ plugin, text, tone, action }) => {
    const name =
      state.plugins.find((p) => p.manifest.id === plugin)?.manifest.name ??
      plugin;
    showPluginToast(name, text, tone, action, (a) =>
      sendEvent(plugin, "toast", a.id, a.payload),
    );
  },
  navigate: ({ plugin, screen, selection }) =>
    navListeners.forEach((l) => l(plugin, screen, selection)),
  popoverShown: () => shownListeners.forEach((l) => l()),
  popoverHiding: () => hidingListeners.forEach((l) => l()),
  settingsChanged: () => settingsListeners.forEach((l) => l()),
  updateState: (s) => updateListeners.forEach((l) => l(s)),
  developmentState: (s) => setDevelopment(s),
  remoteAccessState: (s) => setRemoteAccess(s),
  command: ({ name }) => commandListeners.forEach((l) => l(name)),
  confirmQuit: () => commandListeners.forEach((l) => l("confirmQuit")),
};

type Messages = ToolbeltRPC["webview"]["messages"];
type Requests = ToolbeltRPC["bun"]["requests"];
type BunMessages = ToolbeltRPC["bun"]["messages"];
export type Transport = {
  request: {
    [K in keyof Requests]: (
      p: Requests[K]["params"],
    ) => Promise<Requests[K]["response"]>;
  };
  send: { [K in keyof BunMessages]: (p: BunMessages[K]) => void };
};

/** Inside Toolbelt: Electrobun's RPC. In a browser (remote access, the preview): a WebSocket. */
let socket: ReturnType<typeof createSocketTransport> | null = null;

function connect(): Transport {
  if (inApp) {
    const r = Electroview.defineRPC<ToolbeltRPC>({
      maxRequestTime: 300_000,
      handlers: { requests: {}, messages: handlers as never },
    });
    new Electroview({ rpc: r });
    return r as unknown as Transport;
  }
  socket = createSocketTransport({
    url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`,
    message: (name, payload) =>
      (handlers as Record<string, (p: unknown) => void>)[name]?.(payload),
    connected: (again) => {
      void checkBuild();
      // The first connection resyncs too if the plugin list hasn't arrived yet.
      if (again || !state.pluginsKnown) resync();
    },
    suspended: (hidden) => (hidden ? suspendSurfaces() : resync()),
    label: () =>
      deviceLabel(
        installContext(navigator.userAgent, navigator.maxTouchPoints),
        matchMedia("(display-mode: standalone)").matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true,
      ),
  });
  const proxy = <T>(fn: (name: string, p: unknown) => T) =>
    new Proxy(
      {},
      { get: (_, name: string) => (p: unknown) => fn(name, p) },
    ) as never;
  return {
    request: proxy((method, params) => socket!.request(method, params)),
    send: proxy((name, payload) => socket!.send(name, payload)),
  };
}

/** The browser connection's state (always "open" inside the app). */
export function useConnection(): [ConnectionStatus, () => void] {
  const status = useSyncExternalStore(
    (l) => socket?.subscribe(l) ?? (() => {}),
    () => socket?.status() ?? "open",
  );
  return [status, () => socket?.reconnect()];
}

/** Whether this page has ever reached the Mac (always true inside the app). */
export function useEverConnected(): boolean {
  return useSyncExternalStore(
    (l) => socket?.subscribe(l) ?? (() => {}),
    () => socket?.everConnected() ?? true,
  );
}

/** Pairs this browser with the Mac (docs/remote-access.md, "Pairing"); see connection.ts. */
export function pairDevice(secret: string): Promise<boolean> {
  return socket ? socket.pair(secret) : Promise.reject(new Error("Not connected to your Mac"));
}

/** The paired device this view is (remote devices only), to mark it in Remote Access. */
export const thisDevice = () => socket?.device() ?? null;

/** A newer UI build on the server: reload once to pick it up (the service worker revalidates). */
async function checkBuild() {
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src.split("/").pop() ?? null;
  const served = await rpc.request.buildId({}).catch(() => null);
  if (!served || !mine || served === mine) return;
  try {
    if (sessionStorage.getItem("toolbelt.reloaded-for") === served) return;
    sessionStorage.setItem("toolbelt.reloaded-for", served);
  } catch {
    return;
  }
  await navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  location.reload();
}

export const rpc = connect();
(window as { __tbReport?: unknown }).__tbReport = (
  id: number,
  value: unknown,
) => rpc.send.debugReport({ id, value });

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

let loaded = false;
export function usePlugins(): PluginInfo[] {
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void rpc.request.plugins({}).then((plugins) => set({ plugins })).catch(() => {});
  }, []);
  return useOrderedPlugins(useSyncExternalStore(subscribe, () => state.plugins));
}

/** Whether the host has sent the plugin list yet (until then, "no plugins" means "not known"). */
export function usePluginsKnown(): boolean {
  return useSyncExternalStore(subscribe, () => state.pluginsKnown);
}

// Surfaces this view watches, with how many components watch each. The main process hears one
// open per surface; reconnecting or coming back to the foreground opens them again.
const watched = new Map<string, { plugin: string; surface: string; count: number }>();
const openSurface = (plugin: string, surface: string) =>
  rpc.request.open({ plugin, surface }).then((tree) => {
    const k = key(plugin, surface);
    if (tree && watched.has(k)) set({ trees: { ...state.trees, [k]: tree } });
  });
/** After a reconnect or a return to the foreground: fresh plugins and current trees. */
function resync() {
  void rpc.request.plugins({}).then((plugins) => handlers.plugins(plugins)).catch(() => {});
  // A reconnect while hidden leaves surfaces closed; showing the page opens them.
  if (document.visibilityState === "hidden") return;
  for (const { plugin, surface } of watched.values()) void openSurface(plugin, surface).catch(() => {});
}
/** The page is hidden: stop receiving trees until it's shown again. */
function suspendSurfaces() {
  for (const { plugin, surface } of watched.values())
    void rpc.request.close({ plugin, surface }).catch(() => {});
}

/** Watch a surface while mounted; returns its latest UI tree (or null until the first one). */
export function useSurface(plugin: string, surface: string): Node | null {
  const k = key(plugin, surface);
  useEffect(() => {
    let live = true;
    const entry = watched.get(k);
    if (entry) entry.count++;
    else {
      watched.set(k, { plugin, surface, count: 1 });
      void rpc.request.open({ plugin, surface }).then((tree) => {
        if (live && tree && !state.trees[k])
          set({ trees: { ...state.trees, [k]: tree } });
      }).catch(() => {});
    }
    return () => {
      live = false;
      const current = watched.get(k);
      if (current && --current.count > 0) return;
      watched.delete(k);
      void rpc.request.close({ plugin, surface }).catch(() => {});
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

export const sendEvent = (
  plugin: string,
  surface: string,
  name: string,
  payload?: unknown,
) => void rpc.request.event({ plugin, surface, name, payload });
// For the debug channel: send plugin events from evaluated scripts.
(window as { __tbEvent?: unknown }).__tbEvent = sendEvent;

export function useNavigate(fn: NavListener) {
  useEffect(() => {
    navListeners.add(fn);
    // Asking after subscription covers first creation as well as an already-open window.
    void rpc.request.initialNavigation({}).then(navigation => { if (navigation) handlers.navigate(navigation); });
    return () => void navListeners.delete(fn);
  }, [fn]);
}

export function usePopoverShown(fn: () => void) {
  useEffect(() => {
    shownListeners.add(fn);
    return () => void shownListeners.delete(fn);
  }, [fn]);
}

export function usePopoverHiding(fn: () => void) {
  useEffect(() => {
    hidingListeners.add(fn);
    return () => void hidingListeners.delete(fn);
  }, [fn]);
}

export type ToolbeltSettings = Awaited<
  ReturnType<Transport["request"]["settings"]>
>;

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

// The manager talks to the same production control plane in app and browser transports.
import {
  registerPluginManagerAdapter,
  type ManagerState,
  type Candidate as ManagerCandidate,
} from "../plugin-manager-model";
async function managerRequest(
  params: Parameters<Transport["request"]["pluginManager"]>[0],
) {
  const response = await rpc.request.pluginManager(params);
  if (response.failure) throw new GitHubError(response.failure);
  if (response.error) throw new Error(response.error);
  return response;
}
registerPluginManagerAdapter({
  read: async () => {
    const response = await managerRequest({ operation: "read" });
    return response.state as ManagerState;
  },
  subscribe: (listener) => {
    const handler = (state: Messages["pluginManagerState"]) =>
      listener(state as ManagerState);
    pluginManagerListeners.add(handler);
    return () => {
      pluginManagerListeners.delete(handler);
    };
  },
  resolve: async (input) => {
    const response = await managerRequest({ operation: "resolve", ...input });
    if (!response.candidate) throw new Error("Missing candidate");
    return response.candidate as ManagerCandidate;
  },
  install: async (token) => {
    await managerRequest({ operation: "install", token });
  },
  enable: async (id, enabled) => {
    await managerRequest({ operation: "enable", id, enabled });
  },
  remove: async (id, deleteData) => {
    await managerRequest({ operation: "remove", id, deleteData });
  },
  cancel: async (operationId) => {
    await managerRequest({ operation: "cancel", operationId });
  },
  discard: async (token) => {
    await managerRequest({ operation: "discard", token });
  },
  restart: async (id) => { await rpc.request.restartPlugin({plugin: id}); },
  checkUpdates: async () => {
    await managerRequest({ operation: "checkUpdates" });
  },
  setChannel: async (id, channel) => {
    await managerRequest({ operation: "setChannel", id, channel });
  },
  cleanup: async (id) => {
    const response = await managerRequest({ operation: "cleanup", id });
    if (response.navigate)
      navListeners.forEach((listener) =>
        listener(response.navigate!.plugin, response.navigate!.screen),
      );
  },
  recover: async (id, choiceId) => {
    await managerRequest({ operation: "recover", id, choiceId });
  },
});

// ── plugin development mode (docs/plugin-development.md) ──────────────────
let development: DevelopmentState | null = null;
const developmentListeners = new Set<() => void>();
function setDevelopment(next: DevelopmentState) {
  development = next;
  developmentListeners.forEach((l) => l());
}
let developmentAsked = false;
/** Runs a development request; hosts without development mode report it unavailable. */
export async function developmentRequest(
  request: DevelopmentRequest,
): Promise<DevelopmentResponse> {
  try {
    const response = await rpc.request.development(request);
    setDevelopment(response.state);
    return response;
  } catch (error) {
    if (request.operation === "state") {
      setDevelopment(UNAVAILABLE_DEVELOPMENT);
      return { state: UNAVAILABLE_DEVELOPMENT };
    }
    return { state: development ?? UNAVAILABLE_DEVELOPMENT, error: String(error) };
  }
}
/** Null until the host answers. */
export function useDevelopment(): DevelopmentState | null {
  useEffect(() => {
    if (developmentAsked) return;
    developmentAsked = true;
    void developmentRequest({ operation: "state" });
  }, []);
  return useSyncExternalStore(
    (l) => {
      developmentListeners.add(l);
      return () => void developmentListeners.delete(l);
    },
    () => development,
  );
}

// ── remote access (docs/remote-access.md) ──────────────────────────────────
let remoteAccess: RemoteAccessState | null = null;
const remoteAccessListeners = new Set<() => void>();
function setRemoteAccess(next: RemoteAccessState) {
  remoteAccess = next;
  remoteAccessListeners.forEach((l) => l());
}
/** Runs a remote access operation; the new state also arrives as a message. */
export async function remoteAccessRequest(request: RemoteAccessRequest) {
  const next = await rpc.request.remoteAccess(request);
  setRemoteAccess(next);
  return next;
}
/** Null until the host answers. Reading it refreshes Tailscale's status. */
export function useRemoteAccess(): RemoteAccessState | null {
  useEffect(() => {
    void remoteAccessRequest({ operation: "read" }).catch(() => {});
  }, []);
  return useSyncExternalStore(
    (l) => {
      remoteAccessListeners.add(l);
      return () => void remoteAccessListeners.delete(l);
    },
    () => remoteAccess,
  );
}
