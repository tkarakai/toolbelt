// The plugin side of the Toolbelt protocol (to become `@toolbelt/sdk`).
//
//   import { definePlugin } from "../../src/sdk";
//   definePlugin({
//     views: { "screen:main": { search: true, filters: { status: ["open"] } } },
//     render: { "screen:main": (ctx, view) => page(view.search, view.filters.status) },
//     onEvent: (surface, name, payload, ctx, { instance }) => { … ctx.invalidate(); },
//   });
//
// `render` functions are called once per open instance of a surface (every person's screens
// share one, each agent view has its own), whenever `ctx.invalidate()` is called, with that
// instance's view. Unchanged trees aren't sent again.
import {
  PERSON,
  PROTOCOL_VERSION,
  splitLines,
  type HostMessage,
  type Node,
  type PluginMessage,
  type ToastAction,
  type ViewDeclaration,
  type ViewState,
} from "../shared/protocol";
import { applyView, cleanView, resolveView, viewChange, type View } from "../shared/views";
import { resolve, sep } from "node:path";
import {
  CAPABILITIES,
  SDK_VERSION,
  type MigrationRequest,
} from "../shared/package";
export * from "../shared/package";

export type {
  Node,
  Cell,
  Column,
  Row,
  GroupLabel,
  Action,
  Field,
  EnvironmentEntry,
  Tone,
  Hue,
  Dot,
  DotColor,
  Tag,
  Mark,
  TextStyle,
  Target,
  Section,
  TagKey,
  TagValue,
  OptionItem,
  Filter,
  EventPayloads,
  Dialog,
  LogLine,
  Message,
  Suggestion,
  DetailItem,
  TimelineEntry,
  Manifest,
  HostMessage,
  PluginMessage,
  ToastAction,
  ViewState,
  ViewDeclaration,
} from "../shared/protocol";
export { HUES, MAX_SECTION_DEPTH, PERSON } from "../shared/protocol";
export { applyView, cleanView, resolveView, type View } from "../shared/views";
export { leastUsedHue } from "../shared/hues";
export { duration, relative } from "../shared/time";

/** This plugin's own folder for data (settings, state, logs). Toolbelt creates it. */
export function dataDir(): string {
  return (
    process.env.TOOLBELT_DATA_DIR ??
    `${process.env.TMPDIR ?? "/tmp"}/toolbelt-data/${process.env.TOOLBELT_PLUGIN ?? "plugin"}`
  );
}

/**
 * The command that reaches this ToolBelt's agent interface (`[bun, cli, "--socket", path]`), for a
 * plugin that starts an AI agent and gives it ToolBelt's MCP server: append `"mcp"` (and
 * `"--client", name`). Undefined when ToolBelt has no CLI to offer.
 */
export function agentCommand(): string[] | undefined {
  try {
    const command = JSON.parse(process.env.TOOLBELT_AGENT_COMMAND ?? "null");
    return Array.isArray(command) && command.every((c) => typeof c === "string") ? command : undefined;
  } catch {
    return undefined;
  }
}

export function packageRoot(): string {
  return process.env.TOOLBELT_PACKAGE_ROOT ?? process.cwd();
}
export function payload(relative: string): string {
  const root = resolve(packageRoot(), "payload");
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep))
    throw new Error("payload path escapes package");
  return path;
}
export function asset(name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error("invalid asset name");
  return `asset:${process.env.TOOLBELT_PLUGIN}@${process.env.TOOLBELT_PLUGIN_VERSION}/${name}`;
}
export function defineMigration(
  run: (
    ctx: MigrationRequest & { progress(text: string): void },
  ) => void | Promise<void>,
) {
  void (async () => {
    const line = (await Bun.stdin.text()).trim();
    try {
      const request = JSON.parse(line) as MigrationRequest;
      if (
        request.type !== "migrate" ||
        !request.targetDir ||
        !request.transactionId
      )
        throw new Error("invalid migration request");
      await run({
        ...request,
        progress: (text) =>
          console.log(JSON.stringify({ type: "migration-progress", text })),
      });
      console.log(JSON.stringify({ type: "migration-complete" }));
    } catch (error) {
      console.log(
        JSON.stringify({ type: "migration-failed", error: String(error) }),
      );
      process.exitCode = 1;
    }
  })();
}

export type Context = {
  /** Probe startup must avoid external side effects; final activation uses active mode. */
  readonly mode: "probe" | "active";
  /** Negotiated host capabilities; authors provide fallbacks for unavailable optional features. */
  readonly capabilities: ReadonlySet<string>;
  /** Re-render open surfaces (all, or the ones named), every open instance of each. */
  invalidate(...surfaces: string[]): void;
  badge(value: number | string | null): void;
  /**
   * A short notification in the main window. `action` adds a button that sends its event with
   * surface "toast"; with `ui.toast-key` its `key` (such as `"cmd+z"`) presses it too.
   */
  toast(
    text: string,
    tone?: "default" | "success" | "error",
    action?: ToastAction,
  ): void;
  /** Put text on the clipboard. */
  copy(text: string): void;
  /**
   * Show one of this plugin's screens (its manifest id, without `screen:`) in the main window,
   * optionally selecting the row/list item with id `select`. Call it in response to the
   * person's action (an event, including a toast button): the host ignores navigation that
   * doesn't closely follow one. Returns false (and sends nothing) when the host lacks the
   * `navigate` capability.
   */
  navigate(screen: string, options?: { select?: string }): boolean;
  /** Surfaces with at least one open instance: poll and watch only for these. */
  readonly open: ReadonlySet<string>;
  /**
   * Re-read `views` (when it's a function) and send the declarations to the host. Call it when
   * the data they come from changed, such as filters built from labels the person edits.
   */
  declareViews(): void;
};

/** What an event is about beyond its surface: which instance sent it. */
export type EventInfo = { instance: string };

export type PluginDefinition = {
  prepare?: (
    reason: string,
    ctx: Context,
  ) =>
    | { ready: boolean; reason?: string }
    | Promise<{ ready: boolean; reason?: string }>;
  stop?: (ctx: Context) => void | Promise<void>;
  /**
   * Surface → its view controls and their starting values. The SDK keeps each instance's view,
   * applies its `search`, `filter`, `filter-arrange`, `sort` and page-control `field` events
   * itself (they don't reach `onEvent`), fills the tree's `search.query`, filters' `selected`,
   * tables' `sort` and controls' `value` from it, and tells the host so it can save the person's.
   * A function is read at the handshake and again on `ctx.declareViews()`, for view controls that
   * come from data (a filter per label).
   */
  views?: Record<string, ViewDeclaration> | ((ctx: Context) => Record<string, ViewDeclaration>);
  /**
   * Surface → its UI, rendered once per open instance. Surfaces: `screen:<id>`, `quick` and, for a
   * floating plugin (manifest `floating`), `floating`, whose tree is a `floating` node.
   */
  render: Record<string, (ctx: Context, view: View) => Node | Promise<Node>>;
  onEvent?: (
    surface: string,
    name: string,
    payload: any,
    ctx: Context,
    event: EventInfo,
  ) => void | Promise<void>;
  /** An instance's view changed (after the SDK applied it and before it renders). */
  onView?: (surface: string, view: View, ctx: Context) => void;
  /** Called once after the host said hello. */
  start?: (ctx: Context) => void | Promise<void>;
  /** A surface's first instance opened. */
  onOpen?: (surface: string, ctx: Context) => void;
  /** A surface's last instance closed. */
  onClose?: (surface: string, ctx: Context) => void;
};

export function definePlugin(
  def: PluginDefinition,
  io: {
    write?: (line: string) => void;
    input?: AsyncIterable<Uint8Array>;
  } = {},
) {
  const write = io.write ?? ((line: string) => void process.stdout.write(line));
  const send = (m: PluginMessage) => write(JSON.stringify(m) + "\n");
  const open = new Set<string>();
  /** Surface → instance → its view state. */
  const instances = new Map<string, Map<string, ViewState>>();
  const capabilities = new Set<string>();
  const last = new Map<string, string>();
  let pending: Set<string> | "all" | null = null;
  let views: Record<string, ViewDeclaration> = {};
  const readViews = () => (views = (typeof def.views === "function" ? def.views(ctx) : def.views) ?? {});

  const renderInstance = async (surface: string, instance: string, state: ViewState) => {
    const fn = def.render[surface];
    if (!fn) return;
    const declared = views[surface];
    const view = resolveView(declared, state, instance);
    let tree: Node;
    try {
      tree = applyView(await fn(ctx, view), view, declared);
    } catch (e) {
      tree = {
        type: "empty",
        icon: "triangle-alert",
        title: "This view failed to render",
        description: String((e as Error)?.message ?? e),
      };
    }
    // The instance may have closed while rendering.
    if (!instances.get(surface)?.has(instance)) return;
    const json = JSON.stringify(tree);
    const key = `${surface}\n${instance}`;
    if (last.get(key) === json) return;
    last.set(key, json);
    write(
      `{"type":"render","surface":${JSON.stringify(surface)},"instance":${JSON.stringify(instance)},"tree":${json}}\n`,
    );
  };

  const flush = async () => {
    const which =
      pending === "all"
        ? [...open]
        : [...(pending ?? [])].filter((s) => open.has(s));
    pending = null;
    for (const surface of which)
      for (const [instance, state] of [...(instances.get(surface) ?? [])])
        await renderInstance(surface, instance, state);
  };

  const ctx: Context = {
    mode: process.env.TOOLBELT_LIFECYCLE_MODE === "probe" ? "probe" : "active",
    capabilities,
    invalidate(...surfaces) {
      const wasIdle = pending === null;
      if (surfaces.length === 0 || pending === "all") pending = "all";
      else {
        pending ??= new Set();
        for (const s of surfaces) pending.add(s);
      }
      // Coalesce bursts of invalidations into one render pass.
      if (wasIdle) queueMicrotask(() => void flush());
    },
    badge: (value) => send({ type: "badge", value }),
    toast: (text, tone, action) => send({ type: "toast", text, tone, action }),
    copy: (text) => send({ type: "clipboard", text }),
    navigate(screen, options) {
      if (!capabilities.has("navigate")) return false;
      send({ type: "navigate", screen, ...(options?.select !== undefined && { select: options.select }) });
      return true;
    },
    open,
    declareViews() {
      send({ type: "views", views: readViews() });
      // Declared ids may have gone: each instance keeps only what is still declared.
      for (const [surface, of] of instances)
        for (const [instance, state] of of) of.set(instance, cleanView(views[surface], state));
      ctx.invalidate();
    },
  };

  const setView = (surface: string, instance: string, state: ViewState, report: boolean) => {
    const of = instances.get(surface);
    if (!of?.has(instance)) return;
    of.set(instance, state);
    if (report) send({ type: "view", surface, instance, view: state });
    def.onView?.(surface, resolveView(views[surface], state, instance), ctx);
    ctx.invalidate(surface);
  };

  const handle = async (msg: HostMessage) => {
    switch (msg.type) {
      case "hello":
        capabilities.clear();
        for (const capability of msg.capabilities ?? ["ui.core"])
          capabilities.add(capability);
        if (msg.protocol !== PROTOCOL_VERSION)
          throw new Error("incompatible host protocol");
        send({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          sdk: SDK_VERSION,
          capabilities: [...CAPABILITIES],
          views: readViews(),
        });
        await def.start?.(ctx);
        send({ type: "ready" });
        break;
      case "prepare": {
        const result = (await def.prepare?.(msg.reason, ctx)) ?? {
          ready: true,
        };
        send({ type: "prepared", requestId: msg.requestId, ...result });
        break;
      }
      case "shutdown":
        await def.stop?.(ctx);
        break;
      case "open": {
        const instance = typeof msg.instance === "string" ? msg.instance : PERSON;
        let of = instances.get(msg.surface);
        if (!of) instances.set(msg.surface, (of = new Map()));
        of.set(instance, cleanView(views[msg.surface], msg.view));
        last.delete(`${msg.surface}\n${instance}`); // a new viewer needs the full tree
        if (!open.has(msg.surface)) {
          open.add(msg.surface);
          def.onOpen?.(msg.surface, ctx);
        }
        ctx.invalidate(msg.surface);
        break;
      }
      case "close": {
        const instance = typeof msg.instance === "string" ? msg.instance : PERSON;
        const of = instances.get(msg.surface);
        of?.delete(instance);
        last.delete(`${msg.surface}\n${instance}`);
        if (of && of.size === 0) {
          instances.delete(msg.surface);
          open.delete(msg.surface);
          def.onClose?.(msg.surface, ctx);
        }
        break;
      }
      case "view": {
        // The host sets an instance's view; it gets the cleaned state back.
        setView(msg.surface, msg.instance, cleanView(views[msg.surface], msg.view), true);
        break;
      }
      case "event": {
        const instance = typeof msg.instance === "string" ? msg.instance : PERSON;
        const state = instances.get(msg.surface)?.get(instance);
        const next = state ? viewChange(views[msg.surface], state, msg.name, msg.payload) : null;
        if (next) setView(msg.surface, instance, cleanView(views[msg.surface], next), true);
        else await def.onEvent?.(msg.surface, msg.name, msg.payload, ctx, { instance });
        break;
      }
    }
  };

  const input = io.input ?? Bun.stdin.stream();
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of input) {
      const { lines, rest } = splitLines(
        buf + decoder.decode(chunk, { stream: true }),
      );
      buf = rest;
      for (const line of lines) {
        let msg: HostMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          console.error("toolbelt sdk: bad JSON from host");
          continue;
        }
        await handle(msg).catch((e) => console.error("toolbelt sdk:", e));
      }
    }
    // The host closed our stdin: Toolbelt quit or stopped us.
    if (!io.input) process.exit(0);
  })();

  return ctx;
}
export { search, editDistance, type Search } from "./search";
export { validatePackage } from "./package";
