// The plugin side of the Toolbelt protocol (`@toolbelt/sdk`; docs/plugins.md is the contract).
//
//   import { definePlugin } from "@toolbelt/sdk";
//   definePlugin({
//     views: { "screen:main": { search: true, filters: { status: ["open"] } } },
//     actions: { done: { effect: "write" }, delete: { effect: "destructive" } },
//     forms: { settings: { effect: "write" } },
//     render: { "screen:main": (ctx, view) => page(view.search, view.filters.status) },
//     onEvent: (surface, name, payload, ctx, { instance, origin }) => { … ctx.invalidate(); },
//   });
//
// `render` functions are called once per open instance of a surface (every person's screens
// share one, each agent view has its own), whenever `ctx.invalidate()` is called, with that
// instance's view. Unchanged trees aren't sent again. Trees may use only declared action and
// form ids: the host rejects a render that uses another.
import {
  PERSON,
  PROTOCOL_VERSION,
  splitLines,
  type ActionDeclaration,
  type Declarations,
  type FormDeclaration,
  type HostMessage,
  type Node,
  type Origin,
  type PluginMessage,
  type ToastAction,
  type ViewDeclaration,
  type ViewState,
} from "../shared/protocol";
import { applyView, cleanView, resolveView, viewChange, viewProblem, type View } from "../shared/views";
import { resultDataProblem } from "../shared/validation";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve, sep } from "node:path";
import {
  CAPABILITIES,
  LIMITS,
  SDK_VERSION,
  SECRET_NAME,
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
  Effect,
  ActionDeclaration,
  FormDeclaration,
  Declarations,
  Origin,
} from "../shared/protocol";
export { HUES, MAX_SECTION_DEPTH, PERSON, RESERVED_EVENTS } from "../shared/protocol";
export { applyView, cleanView, resolveView, viewProblem, type View } from "../shared/views";
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

/**
 * The plugin's secrets in the macOS Keychain, kept by ToolBelt (capability `secrets`, declared in
 * toolbelt.json). Read a value when you use it, such as when starting a process that needs an API
 * key; don't copy it into settings, trees, logs or files. Names are 1–128 letters, digits and
 * `. _ / -`; values are non-empty text up to `LIMITS.secretBytes`. Calls reject when the host
 * lacks the capability, the manifest doesn't declare it, or the Keychain refuses.
 */
export type Secrets = {
  /** The value, or null when there's no such secret. */
  get(name: string): Promise<string | null>;
  has(name: string): Promise<boolean>;
  /** Saves (or replaces) a secret. Refused in probe mode. */
  set(name: string, value: string): Promise<void>;
  /** Deletes a secret; deleting one that doesn't exist is fine. Refused in probe mode. */
  delete(name: string): Promise<void>;
};

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
   * surface "toast"; with `ui.toast-key` its `key` (such as `"cmd+z"`) presses it too. Its id
   * must be declared in `actions`, or the toast shows without the button.
   */
  toast(
    text: string,
    tone?: "default" | "success" | "error",
    action?: ToastAction,
  ): void;
  /** Put text on the clipboard. */
  copy(text: string): void;
  /**
   * Show one of this plugin's screens (its manifest id, without `screen:`) on the screen that sent
   * the event being handled, optionally selecting the row/list item with id `select`. Call it
   * while handling an event (`onEvent`, including a toast button): the host ignores navigation
   * that isn't tagged with an event it sent shortly before. Returns false (and sends nothing) when
   * the host lacks the `navigate` capability.
   */
  navigate(screen: string, options?: { select?: string }): boolean;
  /** Surfaces with at least one open instance: poll and watch only for these. */
  readonly open: ReadonlySet<string>;
  /** The plugin's secrets in the Keychain (capability `secrets`). */
  readonly secrets: Secrets;
  /**
   * Re-read `views`, `actions` and `forms` (those that are functions) and send the declarations to
   * the host. Call it when the data they come from changed, such as filters built from labels the
   * person edits. The SDK does it itself once `start` has resolved.
   */
  declare(): void;
};

/** An instance of a surface: which one, and whether the person or an agent opened it. */
export type InstanceInfo = { instance: string; origin: Origin };

/**
 * What an event is about beyond its surface: its id, which instance sent it, whether the person
 * or an agent (`agent`: its client name) did, and that instance's view.
 */
export type EventInfo = { id: string; instance: string; origin: Origin; agent?: string; view: View };

/**
 * What `onEvent` returns: nothing (handled), `false` (not handled) or `{ data }`: JSON of at most
 * `LIMITS.resultBytes` for whoever sent the event, such as created ids or a started job's id.
 */
export type EventResult = void | false | { data?: unknown };

type Declared<T> = Record<string, T> | ((ctx: Context) => Record<string, T>);

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
   * `options` limits the values a filter or control takes. A function is read at the handshake,
   * after `start` and on `ctx.declare()`, for view controls that come from data (a filter per label).
   */
  views?: Declared<ViewDeclaration>;
  /**
   * Action id → what running it does (`effect`), for every action id the plugin's trees and toasts
   * use, on any surface. Built-in event names (`RESERVED_EVENTS`) can't be action ids. Static, or a
   * function read like `views`.
   */
  actions?: Declared<ActionDeclaration>;
  /** Form id → its `effect`, for every `form` node and every page control that isn't a view control. */
  forms?: Declared<FormDeclaration>;
  /**
   * Surface → its UI, rendered once per open instance. Surfaces: `screen:<id>`, `quick` and, for a
   * floating plugin (manifest `floating`), `floating`, whose tree is a `floating` node.
   */
  render: Record<string, (ctx: Context, view: View) => Node | Promise<Node>>;
  /**
   * An event (an action, a field change, a selection). The SDK answers the host with its outcome
   * once this settles: see `EventResult`; a thrown error is reported as the event's error. Toasts,
   * clipboard text and navigation sent while it runs belong to this event.
   */
  onEvent?: (
    surface: string,
    name: string,
    payload: any,
    ctx: Context,
    event: EventInfo,
  ) => EventResult | Promise<EventResult>;
  /**
   * An instance's view is about to change (a view event, the host setting it, or an instance
   * opening with a view), before it renders. Return false to refuse: the instance keeps its view
   * (an opening one starts from the declared defaults) and the host is told.
   */
  onView?: (surface: string, view: View, ctx: Context) => void | false;
  /** Called once after the host said hello. */
  start?: (ctx: Context) => void | Promise<void>;
  /** An instance of a surface opened (every instance; `ctx.open` already lists the surface). */
  onOpen?: (surface: string, ctx: Context, info: InstanceInfo) => void;
  /** An instance of a surface closed (`ctx.open` no longer lists the surface once its last one has). */
  onClose?: (surface: string, ctx: Context, info: InstanceInfo) => void;
};

/** Whether an instance belongs to the person or an agent. */
const originOf = (instance: string): Origin => (instance === PERSON ? "person" : "agent");
const hasView = (state: ViewState) => Object.keys(state).length > 0;

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
  let declarations: Declarations = { views: {}, actions: {}, forms: {} };
  const read = <T,>(d: Declared<T> | undefined): Record<string, T> => (typeof d === "function" ? d(ctx) : d) ?? {};
  const readDeclarations = () => (declarations = { views: read(def.views), actions: read(def.actions), forms: read(def.forms) });
  const views = () => declarations.views;

  // The event being handled: messages sent from its handler's async context while it runs carry
  // its id. Timers and other work started elsewhere (or still running after it) carry none.
  const handling = new AsyncLocalStorage<string>();
  let running: string | undefined;
  const tag = () => {
    const id = handling.getStore();
    return id !== undefined && id === running ? { event: id } : {};
  };

  /** Secret requests waiting for the host's answer. */
  const secretRequests = new Map<string, { resolve: (m: Extract<HostMessage, { type: "secret" }>) => void; timer: ReturnType<typeof setTimeout> }>();
  let secretId = 0;
  const secretRequest = (op: "get" | "has" | "set" | "delete", name: string, value?: string) =>
    new Promise<Extract<HostMessage, { type: "secret" }>>((resolve, reject) => {
      if (!capabilities.has("secrets")) return reject(new Error("This ToolBelt doesn't keep plugin secrets (no secrets capability)"));
      if (typeof name !== "string" || !SECRET_NAME.test(name)) return reject(new Error("A secret's name is 1–128 letters, digits and . _ / -"));
      if (op === "set" && (typeof value !== "string" || value === "" || Buffer.byteLength(value) > LIMITS.secretBytes))
        return reject(new Error(`A secret's value is non-empty text of at most ${LIMITS.secretBytes} bytes`));
      const requestId = `s${++secretId}`;
      // The Keychain may wait for the person to answer a macOS prompt; give up eventually.
      const timer = setTimeout(() => {
        secretRequests.delete(requestId);
        reject(new Error("ToolBelt didn't answer the secret request"));
      }, 150_000);
      secretRequests.set(requestId, {
        timer,
        resolve: (m) => (m.ok ? resolve(m) : reject(new Error(m.error ?? "The secret request failed"))),
      });
      send({ type: "secret", requestId, op, name, ...(op === "set" ? { value } : {}) });
    });
  const secrets: Secrets = {
    get: async (name) => (await secretRequest("get", name)).value ?? null,
    has: async (name) => (await secretRequest("has", name)).exists === true,
    set: async (name, value) => void (await secretRequest("set", name, value)),
    delete: async (name) => void (await secretRequest("delete", name)),
  };

  const renderInstance = async (surface: string, instance: string, state: ViewState) => {
    const fn = def.render[surface];
    if (!fn) return;
    const declared = views()[surface];
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
    toast: (text, tone, action) => send({ type: "toast", text, tone, action, ...tag() }),
    copy: (text) => send({ type: "clipboard", text, ...tag() }),
    navigate(screen, options) {
      if (!capabilities.has("navigate")) return false;
      send({ type: "navigate", screen, ...(options?.select !== undefined && { select: options.select }), ...tag() });
      return true;
    },
    open,
    secrets,
    declare() {
      send({ type: "declarations", declarations: readDeclarations() });
      // Declared ids may have gone: each instance keeps only what is still declared.
      for (const [surface, of] of instances)
        for (const [instance, state] of of) of.set(instance, cleanView(views()[surface], state));
      ctx.invalidate();
    },
  };

  /** Tells the host an instance keeps its view, and why; it renders again so every screen shows it. */
  const refuseView = (surface: string, instance: string, reason: string) => {
    const state = instances.get(surface)?.get(instance) ?? {};
    send({ type: "view", surface, instance, view: state, refused: reason });
    last.delete(`${surface}\n${instance}`);
    ctx.invalidate(surface);
    return reason;
  };

  /**
   * Changes an open instance's view, unless a value is outside the declared options or `onView`
   * refuses it. Returns why it was refused, or null.
   */
  const changeView = (surface: string, instance: string, requested: unknown): string | null => {
    const of = instances.get(surface);
    if (!of?.has(instance)) return null;
    const declared = views()[surface];
    const problem = viewProblem(declared, requested);
    if (problem) return refuseView(surface, instance, problem);
    const state = cleanView(declared, requested);
    if (def.onView?.(surface, resolveView(declared, state, instance), ctx) === false)
      return refuseView(surface, instance, "the plugin refused this view");
    of.set(instance, state);
    send({ type: "view", surface, instance, view: state });
    ctx.invalidate(surface);
    return null;
  };

  const result = (id: string, outcome: { handled: boolean; error?: string; data?: unknown }) =>
    send({ type: "result", id, ...outcome });
  const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 1000);

  /** Runs an event and answers it with its result. */
  const runEvent = async (msg: Extract<HostMessage, { type: "event" }>) => {
    const instance = typeof msg.instance === "string" ? msg.instance : PERSON;
    const origin: Origin = msg.origin === "agent" ? "agent" : "person";
    const id = typeof msg.id === "string" ? msg.id : "";
    const declared = views()[msg.surface];
    const state = instances.get(msg.surface)?.get(instance);
    const next = state ? viewChange(declared, state, msg.name, msg.payload) : null;
    if (next) {
      const refused = changeView(msg.surface, instance, next);
      return result(id, refused === null ? { handled: true } : { handled: false, error: `refused: ${refused}` });
    }
    if (!def.onEvent) return result(id, { handled: false });
    const info: EventInfo = {
      id,
      instance,
      origin,
      ...(origin === "agent" && typeof msg.agent === "string" ? { agent: msg.agent } : {}),
      view: resolveView(declared, state ?? {}, instance),
    };
    running = id;
    try {
      const outcome = await handling.run(id, () => def.onEvent!(msg.surface, msg.name, msg.payload, ctx, info));
      if (outcome === false) return result(id, { handled: false });
      const data = outcome && typeof outcome === "object" ? outcome.data : undefined;
      const problem = resultDataProblem(data);
      if (problem) return result(id, { handled: true, error: `onEvent's result: ${problem}` });
      result(id, { handled: true, ...(data !== undefined ? { data } : {}) });
    } catch (e) {
      result(id, { handled: true, error: message(e) || "the handler failed" });
    } finally {
      running = undefined;
    }
  };

  const handle = async (msg: HostMessage) => {
    switch (msg.type) {
      case "hello": {
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
          declarations: readDeclarations(),
        });
        const greeted = JSON.stringify(declarations);
        await def.start?.(ctx);
        // Declarations that come from data loaded in start: send them without a manual declare().
        if (JSON.stringify(readDeclarations()) !== greeted) send({ type: "declarations", declarations });
        send({ type: "ready" });
        break;
      }
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
        const info: InstanceInfo = { instance, origin: originOf(instance) };
        const declared = views()[msg.surface];
        let of = instances.get(msg.surface);
        if (!of) instances.set(msg.surface, (of = new Map()));
        // The person's saved view loses what's no longer declared or allowed; an agent's view is
        // refused instead when a value is outside the declared options.
        const wanted = cleanView(declared, msg.view);
        of.set(instance, {});
        last.delete(`${msg.surface}\n${instance}`); // a new viewer needs the full tree
        open.add(msg.surface);
        def.onOpen?.(msg.surface, ctx, info);
        let refused = instance === PERSON ? null : viewProblem(declared, msg.view);
        if (!refused && hasView(wanted) && def.onView?.(msg.surface, resolveView(declared, wanted, instance), ctx) === false)
          refused = "the plugin refused this view";
        if (refused) refuseView(msg.surface, instance, refused);
        else of.set(instance, wanted);
        ctx.invalidate(msg.surface);
        break;
      }
      case "close": {
        const instance = typeof msg.instance === "string" ? msg.instance : PERSON;
        const of = instances.get(msg.surface);
        if (!of?.has(instance)) break;
        of.delete(instance);
        last.delete(`${msg.surface}\n${instance}`);
        if (of.size === 0) {
          instances.delete(msg.surface);
          open.delete(msg.surface);
        }
        def.onClose?.(msg.surface, ctx, { instance, origin: originOf(instance) });
        break;
      }
      case "view": {
        // The host sets an instance's view; it gets the cleaned state back (or a refusal).
        changeView(msg.surface, msg.instance, msg.view);
        break;
      }
      case "secret": {
        const waiting = secretRequests.get(msg.requestId);
        if (!waiting) break;
        clearTimeout(waiting.timer);
        secretRequests.delete(msg.requestId);
        waiting.resolve(msg);
        break;
      }
      case "event":
        await runEvent(msg);
        break;
    }
  };

  const input = io.input ?? Bun.stdin.stream();
  (async () => {
    // Messages are handled one at a time, in order, except secret answers: an event handler (or
    // start) waiting for a secret must get its answer while it's still running.
    let queue = Promise.resolve();
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
        const message = msg;
        if (message?.type === "secret") void handle(message);
        else queue = queue.then(() => handle(message)).catch((e) => console.error("toolbelt sdk:", e));
      }
    }
    await queue;
    // The host closed our stdin: Toolbelt quit or stopped us.
    if (!io.input) process.exit(0);
  })();

  return ctx;
}
export { search, editDistance, type Search } from "./search";
export { validatePackage } from "./package";
