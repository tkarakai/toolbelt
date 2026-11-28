import { terminateOwned } from "./owned-process";
// Finds plugins, starts each as a Bun child process, and relays its UI trees to the web views.
// No Electrobun imports here, so it can be tested on its own.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import {
  PERSON,
  PROTOCOL_VERSION,
  parseManifest,
  requireProtocol,
  splitLines,
  type HostMessage,
  type Manifest,
  type Node,
  type PluginMessage,
  type ActionDeclaration,
  type FormDeclaration,
  type ToastAction,
  type ViewDeclaration,
  type ViewState,
} from "../shared/protocol";
import {
  LIMITS,
  CAPABILITIES,
  parsePackageManifest,
  type PackageManifest,
} from "../shared/package";
import { protocolReason, validateMessage, validateEventPayload } from "../shared/validation";
import {
  runtimeEnv,
  verifyPackageBytes,
  type Candidate,
  type Installed,
  readRegistry,
  checkCompatibility,
} from "./packages";
import type { PluginInfo, PluginState } from "../shared/plugin-state";
import { checkEvent, isRefused, undeclared } from "../shared/actions";
import {
  annotateSecrets,
  entrySecret,
  findSecretField,
  planEnvironment,
  type PluginSecrets,
  type SecretStore,
} from "./secrets";

/** Whether a manifest declares a capability, required or optional. */
const declares = (manifest: Manifest, capability: string) => {
  const c = (manifest as PackageManifest).capabilities;
  return !!c && [...(c.required ?? []), ...(c.optional ?? [])].includes(capability);
};

/** A message for the diagnostic log, without secret values. */
function redacted(msg: { type?: unknown; value?: unknown }) {
  return msg.type === "secret" && msg.value !== undefined && msg.value !== null ? { ...msg, value: "[secret]" } : msg;
}

export type Discovered = { manifest: Manifest; dir: string };

/** Every `<dir>/<plugin>/toolbelt.json` under the given directories; first id wins. */
export function discover(
  dirs: string[],
  log: (msg: string) => void = console.error,
): Discovered[] {
  const found = new Map<string, Discovered>();
  for (const root of dirs) {
    if (!existsSync(root)) continue;
    const candidates = existsSync(join(root, "toolbelt.json"))
      ? [root]
      : readdirSync(root).map((d) => join(root, d));
    for (const dir of candidates) {
      const file = join(dir, "toolbelt.json");
      if (!existsSync(file)) continue;
      try {
        const manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")));
        if (!found.has(manifest.id)) found.set(manifest.id, { manifest, dir });
      } catch (e) {
        log(`skipping ${file}: ${(e as Error).message}`);
      }
    }
  }
  return [...found.values()];
}

/**
 * Trees, viewers and render errors are kept per instance of a surface. The person's instance
 * is keyed by the surface alone; an agent instance by `surface\ninstance`.
 */
export const instanceKey = (surface: string, instance: string = PERSON) =>
  instance === PERSON ? surface : `${surface}\n${instance}`;
const splitKey = (key: string) => {
  const i = key.indexOf("\n");
  return i < 0 ? { surface: key, instance: PERSON } : { surface: key.slice(0, i), instance: key.slice(i + 1) };
};

/** Where the host keeps the person's view of each surface (`views.json`, host-owned). */
export type PersonViews = {
  load(plugin: string, surface: string): ViewState | undefined;
  save(plugin: string, surface: string, view: ViewState): void;
};

/**
 * Who sent an event. A person acts from the Mac's window or popover, or from a paired device
 * (`remote`, named by `device` when it's paired). Agents act through a session (wave B1.3).
 */
export type PersonActor = { kind: "person"; via: "window" | "popover" | "remote"; device?: string };
export type Actor = PersonActor | { kind: "agent"; client: string; session: string };
/** The person in the Mac's window: the actor when a caller doesn't say. */
export const WINDOW: PersonActor = { kind: "person", via: "window" };

/** An event the host sent, once its result arrived or the wait for it ended. */
export type EventSettled = {
  id: string;
  plugin: string;
  surface: string;
  name: string;
  actor: Actor;
  /** `ok`: handled; `not-handled`: the plugin doesn't handle it; `no-answer`: no result in time (or the plugin stopped). */
  outcome: "ok" | "not-handled" | "error" | "no-answer";
  error?: string;
  data?: unknown;
};

/** What a plugin message was sent for: the event it handled then (`event`), and who sent that. */
export type EventTag = { id: string; actor: Actor };

type Listener = {
  plugins(list: PluginInfo[]): void;
  /** A surface instance rendered: `instance` is PERSON for every person's view. */
  tree(plugin: string, surface: string, tree: Node, instance: string): void;
  /** The person's view of a surface changed (saved already). */
  view?(plugin: string, surface: string, view: ViewState): void;
  /** `event`: the event the plugin was handling when it sent the toast (B1.3 routes agents' ones). */
  toast(
    plugin: string,
    text: string,
    tone?: "default" | "success" | "error",
    action?: ToastAction,
    event?: EventTag,
  ): void;
  clipboard?(plugin: string, text: string, event?: EventTag): void;
  /**
   * Show the plugin's screen on the view that sent `event` (already checked: a declared screen, an
   * event the host sent within `NAVIGATE_GRACE_MS`, once per event).
   */
  navigate?(plugin: string, screen: string, select: string | undefined, event: EventTag): void;
  /** An event's result arrived, or the wait for it ended. */
  settled?(event: EventSettled): void;
  /** The plugin refused a view change; the instance keeps `view`. */
  viewRefused?(plugin: string, surface: string, instance: string, reason: string, view: ViewState): void;
};

/** How long after the host sent an event the plugin may still navigate the view that sent it. */
export const NAVIGATE_GRACE_MS = 10_000;
/** What an event's settlement says when no result came in time. */
export const NO_ANSWER = `no answer in ${LIMITS.resultMs / 1000} s (the plugin may still act)`;
/** Events kept for tags and navigation after they settle, at most. */
const RECENT_EVENTS = 200;
/** How long a toast's action button stays usable (toasts linger while hovered or hidden), and how many are kept. */
export const TOAST_ACTION_MS = 30 * 60_000;
const TOAST_ACTIONS = 20;
/** What the person sees when ToolBelt drops their event because the screen changed under it. */
export const STALE_EVENT = "That item changed. Try again.";

export class PluginProcess {
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private greeted = false;
  /** SDK version from the latest handshake. */
  private sdk?: string;
  private startupMessages: PluginMessage[] = [];
  private prepared = new Map<
    string,
    {
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private messageWindow = Date.now();
  private messageCount = 0;
  private inputWindow = Date.now();
  private inputBytes = 0;
  private renderCount = 0;
  private stderrWindow = Date.now();
  private stderrBytes = 0;
  waitReady() {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "crashed")
      return Promise.reject(
        new Error(this.error ?? "Plugin activation failed"),
      );
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }
  async prepare(reason: string) {
    if (this.state !== "running") return;
    const requestId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.prepared.delete(requestId);
        reject(new Error("Plugin preparation timed out"));
      }, LIMITS.prepareMs);
      this.prepared.set(requestId, { resolve, reject, timer });
      this.send({ type: "prepare", requestId, reason });
    });
  }
  async stopAndWait() {
    const proc = this.proc;
    this.stop();
    if (proc) await this.terminate(proc);
  }
  private terminations = new WeakMap<ReturnType<typeof Bun.spawn>, Promise<void>>();
  private terminate(proc: ReturnType<typeof Bun.spawn>) {
    const existing = this.terminations.get(proc);
    if (existing) return existing;
    const work = terminateOwned(proc);
    this.terminations.set(proc, work);
    void work.catch(() => {});
    return work;
  }

  state: PluginState = "stopped";
  badge: number | string | null = null;
  error?: string;
  /** Instance key (`instanceKey`) → its latest tree. */
  trees = new Map<string, Node>();
  /** Instance key → when its tree arrived (epoch ms). */
  treeAt = new Map<string, number>();
  /** Instance keys whose last render was rejected, with why: they show the host's error tree. */
  renderErrors = new Map<string, string>();
  /** Instance key → how many viewers have it open. */
  viewers = new Map<string, number>();
  /** Agent instance key → the view it was opened with, as the plugin last reported it. */
  instanceViews = new Map<string, ViewState>();
  /** Surface → its view declaration, from the handshake (or the latest `declarations`). */
  declaredViews: Record<string, ViewDeclaration> = {};
  /** Action id → its declaration; trees may use only these. */
  declaredActions: Record<string, ActionDeclaration> = {};
  /** Form id → its declaration; trees may use only these. */
  declaredForms: Record<string, FormDeclaration> = {};
  /** Events sent to this process: waiting for their result, or settled within the grace window. */
  private events = new Map<string, { surface: string; name: string; actor: Actor; sentAt: number; timer?: ReturnType<typeof setTimeout>; settled: boolean; navigated: boolean }>();
  private proc?: ReturnType<typeof Bun.spawn>;
  private stderrTail: string[] = [];
  private restarts = 0;
  private stopping = false;
  private restartTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly manifest: Manifest,
    readonly dir: string,
    private readonly opts: {
      bun: string;
      env: Record<string, string | undefined>;
      host: { name: string; version: string };
      data: string;
      configRoot?: string;
      mode?: "probe" | "active";
      diagnostic?: (plugin: string, kind: string, detail: unknown) => void;
      verify?: () => void;
      views?: PersonViews;
      /** How to start `toolbelt` against this ToolBelt (null while there's no CLI script). */
      agentCommand?: () => string[] | null;
      /** The plugin's secrets, when its manifest declares the `secrets` capability. */
      secrets?: PluginSecrets;
    },
    private readonly changed: () => void,
    private readonly listener: Listener,
  ) {
    // Fields show whether their secret is saved; redraw them when that changes.
    this.unsubscribe = opts.secrets?.subscribe(() => this.secretsChanged());
  }
  private unsubscribe?: () => void;
  /** This process is replaced or gone: it stops following its plugin's secrets. */
  dispose() {
    this.unsubscribe?.();
  }

  info(): PluginInfo {
    return {
      manifest: this.manifest,
      state: this.state,
      badge: this.badge,
      error: this.error,
      ...(this.sdk ? { sdk: this.sdk } : {}),
    };
  }

  start() {
    try {
      this.opts.verify?.();
      this.startUnchecked();
    } catch (error) {
      this.state = "crashed";
      this.error = String(error);
      this.readyReject?.(new Error(this.error));
      this.changed();
    }
  }
  private startUnchecked() {
    this.messageWindow = Date.now();
    this.messageCount = 0;
    this.inputWindow = Date.now();
    this.inputBytes = 0;
    this.renderCount = 0;
    this.stopping = false;
    this.greeted = false;
    this.startupMessages = [];
    this.state = "starting";
    this.error = undefined;
    this.stderrTail = [];
    // A new process renders afresh: trees from the previous one no longer describe it.
    this.trees.clear();
    this.treeAt.clear();
    this.renderErrors.clear();
    this.toastActions = [];
    this.abandonEvents("the plugin restarted before answering");
    void this.opts.secrets?.load();
    const entry = resolve(this.dir, this.manifest.entry);
    const data =
      (this as any).dataOverride ?? join(this.opts.data, this.manifest.id);
    try {
      mkdirSync(data, { recursive: true });
    } catch (e) {
      throw new Error(
        `can't create its data folder ${data}: ${(e as Error).message}`,
      );
    }
    const proc = Bun.spawn([this.opts.bun, entry], {
      cwd: this.dir,
      detached: true,
      env: {
        ...runtimeEnv(
          { manifest: this.manifest as PackageManifest, packageRoot: this.dir },
          data,
        ),
        TOOLBELT_CONFIG_DIR:
          this.opts.configRoot ?? resolve(this.opts.data, ".."),
        TOOLBELT_LIFECYCLE_MODE: this.opts.mode ?? "active",
        // The command that reaches this ToolBelt's agent socket (`… mcp` is its MCP server), for
        // plugins that hand ToolBelt to an agent they start, like an in-app chat.
        ...(this.opts.agentCommand?.() ? { TOOLBELT_AGENT_COMMAND: JSON.stringify(this.opts.agentCommand()) } : {}),
        ...Object.fromEntries(
          Object.entries(this.opts.env).filter(([k]) =>
            k.startsWith("TOOLBELT_TEST_"),
          ),
        ),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      capabilities: [...CAPABILITIES],
      plugin: { id: this.manifest.id },
      host: this.opts.host,
    });
    this.handshakeTimer = setTimeout(
      () => this.fail("Plugin handshake timed out"),
      LIMITS.handshakeMs,
    );
    this.changed();
    void this.read(proc.stdout as ReadableStream<Uint8Array>, proc).catch(
      (error) => {
        if (this.proc === proc) this.fail(String(error));
      },
    );
    void this.readErr(proc.stderr as ReadableStream<Uint8Array>, proc).catch(
      (error) => {
        if (this.proc === proc) this.fail(String(error));
      },
    );
    void proc.exited.then((code) => this.exited(proc, code));
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.handshakeTimer);
    this.send({ type: "shutdown" });
    clearTimeout(this.restartTimer);
    try {
      (this.proc?.stdin as import("bun").FileSink | undefined)?.end();
    } catch {}
    if (this.proc) void this.terminate(this.proc);
  }

  async restart() {
    await this.stopAndWait();
    this.restarts = 0;
    this.start();
    await this.waitReady();
  }

  send(msg: HostMessage) {
    const stdin = this.proc?.stdin as import("bun").FileSink | undefined;
    if (!stdin || this.state === "crashed") return;
    try {
      this.opts.diagnostic?.(this.manifest.id, "host-message", redacted(msg));
      stdin.write(JSON.stringify(msg) + "\n");
      stdin.flush();
    } catch {}
  }

  /** The view an instance opens with: the person's saved view, or the agent instance's own. */
  private viewOf(surface: string, instance: string) {
    return instance === PERSON
      ? this.opts.views?.load(this.manifest.id, surface)
      : this.instanceViews.get(instanceKey(surface, instance));
  }

  /** Counts a viewer of an instance (the person's by default); an agent instance starts with `view`. */
  open(surface: string, instance: string = PERSON, view?: ViewState) {
    const key = instanceKey(surface, instance);
    const n = (this.viewers.get(key) ?? 0) + 1;
    this.viewers.set(key, n);
    if (n === 1 && instance !== PERSON) this.instanceViews.set(key, view ?? {});
    if (n === 1 && this.state === "running")
      this.send({ type: "open", surface, instance, view: this.viewOf(surface, instance) });
    return this.trees.get(key) ?? null;
  }

  close(surface: string, instance: string = PERSON) {
    const key = instanceKey(surface, instance);
    const n = Math.max(0, (this.viewers.get(key) ?? 0) - 1);
    this.viewers.set(key, n);
    if (n === 0) {
      this.send({ type: "close", surface, instance });
      if (instance !== PERSON) {
        this.viewers.delete(key);
        this.instanceViews.delete(key);
        this.trees.delete(key);
        this.treeAt.delete(key);
        this.renderErrors.delete(key);
      }
    }
  }

  /** Sets an open instance's view (the plugin reports it back cleaned, and re-renders). */
  setView(surface: string, instance: string, view: ViewState) {
    if (this.state === "running") this.send({ type: "view", surface, instance, view });
  }

  private async read(
    stream: ReadableStream<Uint8Array>,
    proc: ReturnType<typeof Bun.spawn>,
  ) {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      if (this.proc !== proc || this.stopping) return;
      if (Date.now() - this.inputWindow >= 1000) {
        this.inputWindow = Date.now();
        this.inputBytes = 0;
        this.renderCount = 0;
      }
      this.inputBytes += chunk.length;
      if (this.inputBytes > LIMITS.messageBytesPerSecond) {
        this.fail("Protocol byte rate exceeded");
        return;
      }
      const { lines, rest } = splitLines(
        buf + decoder.decode(chunk, { stream: true }),
      );
      buf = rest;
      if (Buffer.byteLength(buf) > LIMITS.messageBytes) {
        this.fail("Unterminated protocol frame exceeds limit");
        return;
      }
      for (const line of lines) {
        if (Buffer.byteLength(line) > LIMITS.messageBytes) {
          this.fail("Protocol frame exceeds limit");
          return;
        }
        if (Date.now() - this.messageWindow >= 1000) {
          this.messageWindow = Date.now();
          this.messageCount = 0;
        }
        if (++this.messageCount > LIMITS.messagesPerSecond) {
          this.fail("Protocol message rate exceeds limit");
          return;
        }
        let msg: PluginMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          this.fail("Invalid protocol message: not JSON");
          return;
        }
        try {
          validateMessage(msg);
        } catch (error) {
          // A running plugin's invalid screen costs only that screen: the tree never reaches the
          // renderer, and the plugin and its other screens keep working.
          if (this.renderable(msg)) {
            this.rejectRender(msg.surface, protocolReason(error), typeof msg.instance === "string" ? msg.instance : PERSON);
            continue;
          }
          // A result too large (or otherwise wrong) costs only that event.
          const result = msg as { type?: unknown; id?: unknown } | null;
          if (result && typeof result === "object" && result.type === "result" && typeof result.id === "string" && this.events.has(result.id)) {
            this.settle(result.id, { outcome: "error", error: `its result was refused (${protocolReason(error)})` });
            continue;
          }
          // Say what was wrong (which field, or which limit), so a plugin author can fix it.
          this.fail(`Invalid protocol message: ${protocolReason(error)}`);
          return;
        }
        this.opts.diagnostic?.(
          this.manifest.id,
          "plugin-message",
          msg.type === "secret" ? JSON.stringify(redacted(msg)) : line.slice(0, 16000),
        );
        this.handle(msg);
      }
    }
  }

  private async readErr(
    stream: ReadableStream<Uint8Array>,
    proc: ReturnType<typeof Bun.spawn>,
  ) {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      if (this.proc !== proc || this.stopping) return;
      if (Date.now() - this.stderrWindow >= 1000) {
        this.stderrWindow = Date.now();
        this.stderrBytes = 0;
      }
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > LIMITS.logs) {
        this.fail("Diagnostic log rate exceeded");
        return;
      }
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split("\n").filter(Boolean)) {
        this.stderrTail.push(line.slice(0, 4096));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        this.log(line.slice(0, 4096));
      }
    }
  }

  private fail(error: string) {
    this.abandonEvents("the plugin stopped before answering");
    this.readyReject?.(new Error(error));
    this.readyReject = undefined;
    this.stop();
    this.state = "crashed";
    this.error = error;
    this.changed();
  }

  /** A render for a declared surface, sent while running, within the render rate. */
  private renderable(msg: unknown): msg is { type: "render"; surface: string; instance?: unknown } {
    const m = msg as { type?: unknown; surface?: unknown } | null;
    if (!m || typeof m !== "object" || m.type !== "render" || typeof m.surface !== "string" || this.state !== "running") return false;
    if (!this.declared(m.surface)) return false;
    if (++this.renderCount > LIMITS.rendersPerSecond) {
      this.fail("Render rate exceeded");
      return false;
    }
    return true;
  }

  private declared(surface: string) {
    return this.manifest.screens.some((s) => `screen:${s.id}` === surface) || (!!this.manifest.quickView && surface === "quick") || (!!this.manifest.floating && surface === "floating");
  }

  /** Shows the host's error in place of an instance's invalid tree, and logs why. */
  private rejectRender(surface: string, reason: string, instance: string = PERSON) {
    if (this.state !== "running") return;
    const key = instanceKey(surface, instance);
    if (instance !== PERSON && !this.viewers.get(key)) return; // a closed agent instance
    this.log(`Rejected a render of ${surface}${instance === PERSON ? "" : ` (${instance})`}: ${reason}`);
    const previous = this.renderErrors.get(key);
    this.renderErrors.set(key, reason);
    const tree: Node = {
      type: "empty",
      icon: "triangle-alert",
      title: "This screen couldn't be shown",
      description: `${this.manifest.name} sent a screen ToolBelt can't display (${reason}). The rest of the plugin keeps working; it shows the screen again once it sends a valid one.`,
    };
    this.trees.set(key, tree);
    this.treeAt.set(key, Date.now());
    // The same error again needn't redraw.
    if (previous !== reason) this.listener.tree(this.manifest.id, surface, tree, instance);
  }

  private handle(msg: PluginMessage) {
    if (msg.type === "hello") {
      if (
        this.greeted ||
        msg.protocol !== PROTOCOL_VERSION ||
        ((this.manifest as PackageManifest).capabilities?.required ?? []).some(
          (c) => !msg.capabilities.includes(c),
        )
      ) {
        this.fail("Plugin handshake mismatch");
        return;
      }
      this.greeted = true;
      this.sdk = typeof msg.sdk === "string" ? msg.sdk.slice(0, 64) : undefined;
      this.declare(msg.declarations);
      return;
    }
    // Declarations from `start` arrive before ready; renders need them at once.
    if (msg.type === "declarations" && this.greeted) {
      this.declare(msg.declarations);
      return;
    }
    if (msg.type === "ready") {
      if (!this.greeted || this.state !== "starting") {
        this.fail("Unexpected ready message");
        return;
      }
      clearTimeout(this.handshakeTimer);
      this.state = "running";
      this.readyResolve?.();
      this.readyResolve = undefined;
      for (const message of this.startupMessages) this.handle(message);
      this.startupMessages = [];
      for (const [key, n] of this.viewers)
        if (n > 0) {
          const { surface, instance } = splitKey(key);
          this.send({ type: "open", surface, instance, view: this.viewOf(surface, instance) });
        }
      this.changed();
      return;
    }
    if (msg.type === "prepared") {
      const pending = this.prepared.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.prepared.delete(msg.requestId);
        if (msg.ready) pending.resolve();
        else pending.reject(new Error(msg.reason ?? "Plugin busy"));
      }
      return;
    }
    // Secrets can be read while starting (a plugin's start() may need one).
    if (msg.type === "secret") {
      if (!this.greeted) {
        this.fail("Message before hello");
        return;
      }
      this.secretRequest(msg);
      return;
    }
    if (this.state !== "running") {
      if (
        this.greeted &&
        msg.type !== "render" &&
        this.startupMessages.length < 32
      ) {
        this.startupMessages.push(msg);
        return;
      }
      this.fail("Message before ready");
      return;
    }
    switch (msg.type) {
      case "render":
        if (++this.renderCount > LIMITS.rendersPerSecond) {
          this.fail("Render rate exceeded");
          return;
        }
        if (!this.declared(msg.surface)) {
          this.fail("Undeclared surface");
          return;
        }
        // A render for an instance that has closed (or never opened) is late, not wrong.
        if (msg.instance !== PERSON && !this.viewers.get(instanceKey(msg.surface, msg.instance))) return;
        let secretFields = false;
        try {
          const check = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            const field = value as { type?: unknown; secret?: unknown; secretPrefix?: unknown };
            if ((field.type === "text" && field.secret !== undefined) || (field.type === "environment" && field.secretPrefix !== undefined)) secretFields = true;
            for (const [key, child] of Object.entries(value)) {
              if (
                key === "icon" &&
                typeof child === "string" &&
                child.startsWith("asset:")
              ) {
                const prefix = `asset:${this.manifest.id}@${this.manifest.version}/`;
                if (
                  !child.startsWith(prefix) ||
                  !(this.manifest as PackageManifest).assets?.[
                    child.slice(prefix.length)
                  ]
                )
                  throw new Error(
                    "Undeclared or cross-package asset reference",
                  );
              }
              if (child && typeof child === "object") check(child);
            }
          };
          check(msg.tree);
          if (secretFields && !this.opts.secrets)
            throw new Error("Secret fields need the secrets capability in toolbelt.json");
          // Every action and form id must be declared: the host knows what each one does.
          const missing = undeclared(msg.tree, { actions: this.declaredActions, forms: this.declaredForms, view: this.declaredViews[msg.surface] });
          if (missing) throw new Error(missing);
        } catch (error) {
          this.rejectRender(msg.surface, protocolReason(error), msg.instance);
          return;
        }
        {
          const secrets = this.opts.secrets;
          const tree = secrets && secretFields ? annotateSecrets(msg.tree, (name) => secrets.stored(name)) : msg.tree;
          const key = instanceKey(msg.surface, msg.instance);
          this.renderErrors.delete(key);
          this.trees.set(key, tree);
          this.treeAt.set(key, Date.now());
          this.listener.tree(this.manifest.id, msg.surface, tree, msg.instance);
        }
        break;
      case "view":
        if (!this.declared(msg.surface)) {
          this.fail("Undeclared surface");
          return;
        }
        if (msg.refused !== undefined) {
          this.log(`refused a view of ${msg.surface}${msg.instance === PERSON ? "" : ` (${msg.instance})`}: ${msg.refused.slice(0, 200)}`);
          this.listener.viewRefused?.(this.manifest.id, msg.surface, msg.instance, msg.refused.slice(0, 1000), msg.view);
        }
        if (msg.instance === PERSON) {
          this.opts.views?.save(this.manifest.id, msg.surface, msg.view);
          this.listener.view?.(this.manifest.id, msg.surface, msg.view);
        } else if (this.viewers.get(instanceKey(msg.surface, msg.instance)))
          this.instanceViews.set(instanceKey(msg.surface, msg.instance), msg.view);
        break;
      case "result":
        if (!this.events.get(msg.id) || this.events.get(msg.id)!.settled) {
          this.log(`result for an unknown or settled event ignored`);
          break;
        }
        this.settle(msg.id, {
          // Not handled (`error` may say why, such as a refused view change); handled with an error: it failed.
          outcome: !msg.handled ? "not-handled" : msg.error !== undefined ? "error" : "ok",
          ...(msg.error !== undefined ? { error: msg.error.slice(0, 1000) } : {}),
          ...(msg.data !== undefined ? { data: msg.data } : {}),
        });
        break;
      case "badge":
        this.badge = msg.value;
        this.changed();
        break;
      case "toast": {
        let action = msg.action;
        // A toast button runs an action like any other: its id must be declared.
        if (action && !Object.hasOwn(this.declaredActions, action.id)) {
          this.log(`toast shown without its button: action ${JSON.stringify(action.id.slice(0, 64))} isn't declared in actions`);
          action = undefined;
        }
        if (action)
          this.toastActions = [...this.toastActions, { id: action.id, payload: JSON.stringify(action.payload ?? null), at: Date.now() }].slice(-TOAST_ACTIONS);
        this.listener.toast(this.manifest.id, msg.text, msg.tone, action, this.tagOf(msg.event));
        break;
      }
      case "clipboard":
        this.listener.clipboard?.(this.manifest.id, msg.text, this.tagOf(msg.event));
        break;
      case "navigate": {
        // Navigation goes back to the view that sent the event the plugin was handling.
        const event = msg.event !== undefined ? this.events.get(msg.event) : undefined;
        if (!this.manifest.screens.some((s) => s.id === msg.screen))
          this.log(`navigate ignored: undeclared screen ${JSON.stringify(msg.screen.slice(0, 64))}`);
        else if (!event || Date.now() - event.sentAt > NAVIGATE_GRACE_MS)
          this.log("navigate ignored: not in response to a recent event");
        else if (event.navigated) this.log("navigate ignored: the event already navigated");
        else {
          event.navigated = true; // one navigation per event
          this.listener.navigate?.(this.manifest.id, msg.screen, msg.select, { id: msg.event!, actor: event.actor });
        }
        break;
      }
    }
  }

  /** Takes the plugin's declarations, keeping views only for surfaces the manifest has. */
  private declare(d: { views: Record<string, ViewDeclaration>; actions: Record<string, ActionDeclaration>; forms: Record<string, FormDeclaration> }) {
    this.declaredViews = Object.fromEntries(Object.entries(d.views).filter(([surface]) => this.declared(surface)));
    this.declaredActions = d.actions;
    this.declaredForms = d.forms;
  }

  /** The event a plugin message is tagged with, while the host still knows it. */
  private tagOf(id: string | undefined): EventTag | undefined {
    const event = id !== undefined ? this.events.get(id) : undefined;
    return event ? { id: id!, actor: event.actor } : undefined;
  }

  /** Sends an event and waits (`LIMITS.resultMs`) for its result. */
  private sendEvent(id: string, surface: string, instance: string, name: string, payload: unknown, actor: Actor) {
    const record = { surface, name, actor, sentAt: Date.now(), settled: false, navigated: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    record.timer = setTimeout(() => this.settle(id, { outcome: "no-answer", error: NO_ANSWER }), LIMITS.resultMs);
    this.events.set(id, record);
    this.send({
      type: "event",
      id,
      surface,
      instance,
      name,
      payload,
      origin: actor.kind,
      ...(actor.kind === "agent" ? { agent: actor.client } : {}),
    });
    // Forget settled events past the grace window, and the oldest beyond a bound.
    const now = Date.now();
    for (const [key, e] of this.events)
      if (e.settled && (now - e.sentAt > NAVIGATE_GRACE_MS || this.events.size > RECENT_EVENTS)) this.events.delete(key);
  }

  /** Records an event's outcome once, and tells the listeners. */
  private settle(id: string, outcome: Pick<EventSettled, "outcome" | "error" | "data">) {
    const event = this.events.get(id);
    if (!event || event.settled) return;
    event.settled = true;
    clearTimeout(event.timer);
    if (outcome.outcome === "error" || outcome.outcome === "no-answer")
      this.log(`event ${JSON.stringify(event.name.slice(0, 64))} on ${event.surface}: ${outcome.outcome}${outcome.error ? ` (${outcome.error.slice(0, 200)})` : ""}`);
    this.listener.settled?.({ id, plugin: this.manifest.id, surface: event.surface, name: event.name, actor: event.actor, ...outcome });
  }

  /** Events this process will never answer (it stopped or restarted): no answer. */
  private abandonEvents(reason: string) {
    for (const [id, e] of this.events) if (!e.settled) this.settle(id, { outcome: "no-answer", error: reason });
    this.events.clear();
  }

  /** Answers a plugin's `secret` request; values never reach the logs. */
  private pendingSecrets = 0;
  private secretRequest(msg: Extract<PluginMessage, { type: "secret" }>) {
    const reply = (answer: Omit<Extract<HostMessage, { type: "secret" }>, "type" | "requestId">) =>
      this.send({ type: "secret", requestId: msg.requestId, ...answer });
    const secrets = this.opts.secrets;
    if (!secrets) return reply({ ok: false, error: "Declare the secrets capability in toolbelt.json to keep secrets" });
    if ((msg.op === "set" || msg.op === "delete") && (this.opts.mode ?? "active") === "probe")
      return reply({ ok: false, error: "Secrets can't change while ToolBelt checks an update (probe mode)" });
    if (this.pendingSecrets >= LIMITS.secretRequests) return reply({ ok: false, error: "Too many secret requests at once" });
    const proc = this.proc;
    this.pendingSecrets++;
    void (async () => {
      try {
        if (msg.op === "get") return { ok: true, value: await secrets.get(msg.name) };
        if (msg.op === "has") return { ok: true, exists: await secrets.has(msg.name) };
        if (msg.op === "set") await secrets.set(msg.name, msg.value!);
        else await secrets.delete(msg.name);
        return { ok: true };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log(`secrets: ${msg.op} ${msg.name} failed: ${reason}`);
        return { ok: false, error: reason };
      }
    })().then((answer) => {
      this.pendingSecrets--;
      // A restarted process has its own requests.
      if (this.proc === proc) reply(answer);
    });
  }

  /** Redraws trees whose secret fields' saved state changed. */
  private secretsChanged() {
    const secrets = this.opts.secrets;
    if (!secrets) return;
    for (const [key, tree] of this.trees) {
      if (this.renderErrors.has(key)) continue;
      const next = annotateSecrets(tree, (name) => secrets.stored(name));
      if (next === tree) continue;
      this.trees.set(key, next);
      const { surface, instance } = splitKey(key);
      this.listener.tree(this.manifest.id, surface, next, instance);
    }
  }

  /** Toast action buttons this process offered recently (surface "toast" events answer them). */
  private toastActions: { id: string; payload: string; at: number }[] = [];

  /**
   * Why a person's event doesn't match what their screen offers (null: it does). Events are
   * checked against the person instance's current tree (`checkEvent`, src/shared/actions.ts),
   * which is never older than what their screens show; a surface with no tree offers nothing.
   * Toast buttons are checked against the toasts this process sent.
   */
  private refusal(surface: string, name: string, payload: unknown): string | null {
    if (surface === "toast") {
      const sent = JSON.stringify(payload ?? null);
      const now = Date.now();
      return this.toastActions.some((t) => t.id === name && t.payload === sent && now - t.at <= TOAST_ACTION_MS) ? null : "no recent toast offers it";
    }
    if (!this.declared(surface)) return "the surface isn't declared";
    const tree = this.trees.get(instanceKey(surface));
    if (!tree) return "nothing is shown there yet";
    const resolved = checkEvent(tree, name, payload, this.declaredViews[surface]);
    return isRefused(resolved) ? resolved.refused : null;
  }

  /** Person's events waiting behind a Keychain write, so they reach the plugin in order. */
  private eventChain: Promise<void> | null = null;
  /**
   * A person's event, delivered only when their screen offers it. A refused one is dropped and
   * logged, and the person is told (quietly) unless it was a selection or a dialog closing,
   * which they didn't ask to happen. A secret field's value goes to the Keychain; the plugin
   * hears only the outcome. Returns the event's id, or null when it was refused.
   */
  personEvent(surface: string, name: string, payload: unknown, actor: PersonActor = WINDOW): string | null {
    const refused = this.refusal(surface, name, payload);
    if (refused !== null) {
      const marked = name === "field" && !!payload && typeof payload === "object" && (payload as { secret?: unknown }).secret !== undefined;
      this.log(`refused ${JSON.stringify(name.slice(0, 64))} on ${surface}: ${refused}`);
      if (marked) this.secretProblem("That field changed before ToolBelt could save it. Type it again.");
      else if (name !== "select" && name !== "dialog-close") this.listener.toast(this.manifest.id, STALE_EVENT);
      return null;
    }
    const id = crypto.randomUUID();
    const secret = name === "field" ? this.secretField(surface, payload) : null;
    const deliver = (out: unknown) => this.sendEvent(id, surface, PERSON, name, out, actor);
    if (!secret && !this.eventChain) {
      deliver(payload);
      return id;
    }
    const chain: Promise<void> = (this.eventChain ?? Promise.resolve())
      .then(async () => {
        const out = secret ? await secret() : payload;
        if (out === undefined) return;
        deliver(out);
      })
      .catch((error) => this.log(`event failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.eventChain === chain) this.eventChain = null;
      });
    this.eventChain = chain;
    return id;
  }

  private secretProblem(text: string) {
    this.log(`secrets: ${text}`);
    this.listener.toast(this.manifest.id, text, "error");
  }

  /**
   * For a `field` event on a secret field (as the person's tree has it): the work that stores or
   * removes the secret and returns the payload the plugin gets (undefined: none). Null for other
   * fields. An event the renderer marked secret for a field that is no longer one is dropped.
   */
  private secretField(surface: string, payload: unknown): (() => Promise<unknown>) | null {
    const p = payload as { form?: unknown; field?: unknown; value?: unknown; rowId?: unknown; secret?: unknown } | null;
    if (!p || typeof p !== "object" || typeof p.form !== "string" || typeof p.field !== "string") return null;
    const rowId = typeof p.rowId === "string" ? p.rowId : undefined;
    const base = { form: p.form, field: p.field, ...(rowId !== undefined ? { rowId } : {}) };
    const field = findSecretField(this.trees.get(instanceKey(surface)), p.form, p.field, rowId);
    const secrets = this.opts.secrets;
    if (!field || !secrets) {
      if (p.secret === undefined) return null;
      return async () => {
        this.secretProblem("That field changed before ToolBelt could save it. Type it again.");
        return undefined;
      };
    }
    if (field.type === "text") {
      const name = field.secret!;
      return async () => {
        try {
          if (p.value === null || p.value === false) {
            await secrets.delete(name);
            return { ...base, value: false, secret: name };
          }
          if (typeof p.value !== "string" || p.value === "") return undefined;
          await secrets.set(name, p.value);
          return { ...base, value: true, secret: name };
        } catch (error) {
          this.secretProblem(`${field.label || name}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      };
    }
    const prefix = field.secretPrefix!;
    const entries = Array.isArray(p.value) ? p.value : null;
    if (
      !entries ||
      !entries.every(
        (e) => e && typeof e === "object" && typeof e.key === "string" && typeof e.value === "string" && typeof e.selected === "boolean" && typeof e.secret === "boolean",
      )
    )
      return async () => undefined;
    const plan = planEnvironment(prefix, entries, field.value);
    return async () => {
      const failures: string[] = [];
      for (const { name, value } of plan.writes)
        await secrets.set(name, value).catch((error) => failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`));
      for (const name of plan.deletes)
        await secrets.delete(name).catch((error) => failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`));
      if (plan.invalid.length)
        this.secretProblem(
          `ToolBelt didn't save the value of ${plan.invalid.map((k) => k || "an unnamed variable").join(", ")}: a variable kept in the Keychain needs a name of letters, digits and . _ - (with the prefix, at most 128 characters).`,
        );
      if (failures.length) this.secretProblem(`${field.label || "Environment"}: ${failures.join("; ")}`);
      return {
        ...base,
        value: plan.entries.map((e) => {
          if (!e.secret) return e;
          const name = entrySecret(prefix, e.key);
          return { ...e, stored: name ? secrets.stored(name) : false };
        }),
      };
    };
  }

  private async exited(proc: ReturnType<typeof Bun.spawn>, code: number | null) {
    if (proc !== this.proc) return; // an older process after a restart
    clearTimeout(this.handshakeTimer);
    this.abandonEvents("the plugin stopped before answering");
    this.readyReject?.(
      new Error(
        `Plugin exited before ready (${code}): ${this.stderrTail.slice(-8).join("\n")}`,
      ),
    );
    this.readyReject = undefined;
    try {
      await this.terminate(proc);
    } catch (error) {
      this.state = "crashed";
      this.error = String(error);
      this.changed();
      return;
    }
    if (proc !== this.proc) return;
    if (this.stopping) {
      if (this.state !== "crashed") this.state = "stopped";
      this.changed();
      return;
    }
    this.log(`exited with ${code}`);
    // Restart a crashing plugin a few times, backing off; then leave it crashed.
    if (this.restarts < 3) {
      this.restarts++;
      this.state = "starting";
      this.changed();
      this.restartTimer = setTimeout(
        () => this.start(),
        500 * 2 ** this.restarts,
      );
      return;
    }
    this.state = "crashed";
    this.error = this.stderrTail.slice(-8).join("\n") || `exited with ${code}`;
    this.changed();
  }

  private log(line: string) {
    this.opts.diagnostic?.(this.manifest.id, "stderr", line.slice(0, 4096));
    console.error(`[${this.manifest.id}] ${line.slice(0, 4096)}`);
  }
}

export class PluginHost {
  private restarting = new Map<string, Promise<void>>();
  private plugins = new Map<string, PluginProcess>();
  private listeners = new Set<Listener>();

  /** `data`: the folder that holds each plugin's data folder (`<data>/<id>/`). */
  constructor(
    private readonly opts: {
      registryRoot?: string;
      diagnostic?: (plugin: string, kind: string, detail: unknown) => void;
      dirs: string[];
      bun: string;
      env?: Record<string, string | undefined>;
      host: { name: string; version: string };
      data: string;
      /** Where the person's views are saved; without it they last only while the plugin runs. */
      views?: PersonViews;
      /** How to start `toolbelt` against this ToolBelt, passed to plugins as `TOOLBELT_AGENT_COMMAND`. */
      agentCommand?: () => string[] | null;
      /** Where plugins that declare `secrets` keep them; without it they're refused. */
      secrets?: SecretStore;
    },
  ) {}

  /** Deletes a plugin's secrets (removing it with its data). Failures are logged, not thrown. */
  async deleteSecrets(plugin: { id: string; name: string; repo?: string }) {
    await this.opts.secrets?.deleteAll(plugin);
  }

  start() {
    let entries: { manifest: Manifest; dir: string }[] = [];
    try {
      entries = this.opts.registryRoot
        ? Object.values(readRegistry(this.opts.registryRoot).plugins)
            .filter((p) => p.enabled && !p.removed)
            .map((p) => ({ manifest: p.manifest, dir: p.packageRoot }))
        : discover(this.opts.dirs);
    } catch (error) {
      // A plugin list ToolBelt can't read starts no plugins; the plugin manager says why.
      console.error(`plugins: ${(error as Error).message}`);
    }
    for (const { manifest, dir } of entries) {
      const p = this.makeProcess(manifest, dir, this.opts.data);
      this.plugins.set(manifest.id, p);
      try {
        requireProtocol(manifest);
        if (this.opts.registryRoot) {
          const record = readRegistry(this.opts.registryRoot).plugins[
            manifest.id
          ];
          if (record)
            verifyPackageBytes(
              this.opts.registryRoot,
              record,
              this.opts.host.version,
            );
        }
        if (this.opts.registryRoot) {
          checkCompatibility(
            parsePackageManifest(manifest),
            this.opts.host.version,
          );
        }
        p.start();
      } catch (error) {
        p.state = "crashed";
        p.error = String(error);
        this.emitPlugins();
      }
    }
  }

  stop() {
    for (const p of this.plugins.values()) p.stop();
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => p.info());
  }

  /** Counts a viewer of a surface instance: the person's by default, or an agent's with its view. */
  open(plugin: string, surface: string, instance: string = PERSON, view?: ViewState) {
    return this.get(plugin).open(surface, instance, view);
  }

  close(plugin: string, surface: string, instance: string = PERSON) {
    this.plugins.get(plugin)?.close(surface, instance);
  }

  /** Sets an open instance's view: the person's (an agent showing them something, Restore). */
  setView(plugin: string, surface: string, instance: string, view: ViewState) {
    this.get(plugin).setView(surface, instance, view);
  }

  /** A surface's view declaration from the plugin's handshake (null when it declares none). */
  declaredView(plugin: string, surface: string): ViewDeclaration | null {
    return this.plugins.get(plugin)?.declaredViews[surface] ?? null;
  }

  /** The person's view of a surface: saved state, else nothing (the declared defaults apply). */
  personView(plugin: string, surface: string): ViewState {
    return this.opts.views?.load(plugin, surface) ?? {};
  }

  /** An agent instance's view, as the plugin last reported it (undefined when it isn't open). */
  instanceView(plugin: string, surface: string, instance: string): ViewState | undefined {
    return this.plugins.get(plugin)?.instanceViews.get(instanceKey(surface, instance));
  }

  /** The latest tree of a surface's person instance, without counting a viewer. */
  tree(plugin: string, surface: string) {
    return this.get(plugin).trees.get(surface) ?? null;
  }

  /** The latest tree of an instance with when it arrived, and how many viewers have it open. */
  snapshot(plugin: string, surface: string, instance: string = PERSON) {
    const p = this.plugins.get(plugin);
    if (!p) return null;
    const key = instanceKey(surface, instance);
    return {
      tree: p.renderErrors.has(key) ? null : (p.trees.get(key) ?? null),
      at: p.treeAt.get(key) ?? 0,
      viewers: p.viewers.get(key) ?? 0,
      ...(p.renderErrors.has(key) ? { error: p.renderErrors.get(key)! } : {}),
    };
  }

  /**
   * A person's event (every person's screen is the PERSON instance), from `actor` (the Mac's window
   * by default). Returns its id, which tags what the plugin sends while handling it and names its
   * result (`settled`), or null when the person's screen doesn't offer it.
   */
  event(plugin: string, surface: string, name: string, payload?: unknown, actor: PersonActor = WINDOW): string | null {
    if (
      typeof name !== "string" ||
      name.length > 256 ||
      typeof surface !== "string" ||
      surface.length > 256
    )
      throw new Error("Invalid event metadata");
    validateEventPayload(payload);
    return this.get(plugin).personEvent(surface, name, payload, actor);
  }

  async restart(plugin: string) {
    const existing = this.restarting.get(plugin);
    if (existing) return existing;
    const p = this.get(plugin),
      work = (async () => {
        await p.prepare("restart");
        await p.restart();
      })();
    this.restarting.set(plugin, work);
    try {
      await work;
    } finally {
      if (this.restarting.get(plugin) === work) this.restarting.delete(plugin);
    }
  }

  async prepare(id: string, reason: string) {
    await this.plugins.get(id)?.prepare(reason);
  }
  async stopPlugin(id: string) {
    await this.plugins.get(id)?.stopAndWait();
  }
  remove(id: string) {
    this.plugins.get(id)?.stop();
    this.plugins.get(id)?.dispose();
    this.plugins.delete(id);
    this.emitPlugins();
  }
  async activate(installed: Installed) {
    const previous = this.plugins.get(installed.id);
    const viewers = new Map(previous?.viewers ?? []);
    const instanceViews = new Map(previous?.instanceViews ?? []);
    this.remove(installed.id);
    const p = this.makeProcess(
      installed.manifest,
      installed.packageRoot,
      this.opts.data,
    );
    for (const [key, count] of viewers) p.viewers.set(key, count);
    for (const [key, view] of instanceViews) p.instanceViews.set(key, view);
    this.plugins.set(installed.id, p);
    p.start();
    await p.waitReady();
    this.emitPlugins();
  }
  async probe(candidate: Candidate, dataDir: string) {
    const p = this.makeProcess(
      candidate.manifest,
      candidate.packageRoot,
      resolve(dataDir, ".."),
    );
    // Probe uses explicit staged path, not a production plugin data location.
    (p as any).opts.data = resolve(dataDir, "..");
    (p as any).dataOverride = dataDir;
    (p as any).opts.mode = "probe";
    p.start();
    try {
      await p.waitReady();
    } finally {
      p.dispose();
      await p.stopAndWait();
    }
  }
  private makeProcess(manifest: Manifest, dir: string, data: string) {
    return new PluginProcess(
      manifest,
      dir,
      {
        bun: this.opts.bun,
        env: this.opts.env ?? {},
        host: this.opts.host,
        data,
        configRoot: this.opts.registryRoot,
        diagnostic: this.opts.diagnostic,
        views: this.opts.views,
        agentCommand: this.opts.agentCommand,
        secrets:
          this.opts.secrets && declares(manifest, "secrets")
            ? this.opts.secrets.forPlugin({ id: manifest.id, name: manifest.name, repo: (manifest as PackageManifest).repo })
            : undefined,
        verify: this.opts.registryRoot
          ? () => {
              const m = parsePackageManifest(manifest),
                hash = basename(dir).slice(m.version.length + 1);
              if (
                !/^[a-f0-9]{64}$/.test(hash) ||
                resolve(dir) !==
                  resolve(
                    this.opts.registryRoot!,
                    "plugins/packages",
                    m.id,
                    `${m.version}-${hash}`,
                  )
              )
                throw new Error("Unapproved package activation path");
              verifyPackageBytes(
                this.opts.registryRoot!,
                { manifest: m, hash, packageRoot: dir, repo: m.repo },
                this.opts.host.version,
              );
            }
          : undefined,
      },
      () => this.emitPlugins(),
      {
        plugins: () => {},
        tree: (plugin, surface, tree, instance) =>
          this.listeners.forEach((l) => {
            try {
              l.tree(plugin, surface, tree, instance);
            } catch {}
          }),
        view: (plugin, surface, view) =>
          this.listeners.forEach((l) => {
            try {
              l.view?.(plugin, surface, view);
            } catch {}
          }),
        toast: (plugin, text, tone, action, event) =>
          this.listeners.forEach((l) => {
            try {
              l.toast(plugin, text, tone, action, event);
            } catch {}
          }),
        clipboard: (plugin, text, event) =>
          this.listeners.forEach((l) => {
            try {
              l.clipboard?.(plugin, text, event);
            } catch {}
          }),
        navigate: (plugin, screen, select, event) =>
          this.listeners.forEach((l) => {
            try {
              l.navigate?.(plugin, screen, select, event);
            } catch {}
          }),
        settled: (event) =>
          this.listeners.forEach((l) => {
            try {
              l.settled?.(event);
            } catch {}
          }),
        viewRefused: (plugin, surface, instance, reason, view) =>
          this.listeners.forEach((l) => {
            try {
              l.viewRefused?.(plugin, surface, instance, reason, view);
            } catch {}
          }),
      },
    );
  }

  private get(id: string) {
    const p = this.plugins.get(id);
    if (!p) throw new Error(`no plugin ${id}`);
    return p;
  }

  private emitPlugins() {
    const list = this.list();
    this.listeners.forEach((l) => {
      try {
        l.plugins(list);
      } catch {}
    });
  }
}

/** Toolbelt's folder: settings, plugins, plugin data. `TOOLBELT_CONFIG_DIR` overrides it. */
export const configDir = (
  home: string,
  env: Record<string, string | undefined> = process.env,
) =>
  env.TOOLBELT_CONFIG_DIR ?? join(home, "Library/Application Support/Toolbelt");

/** Where plugins live: bundled ones, the person's installed ones, and `TOOLBELT_PLUGINS`. */
export function pluginDirs(opts: {
  bundled?: string;
  home: string;
  extra?: string;
}) {
  return [
    ...(opts.extra ? opts.extra.split(":").filter(Boolean) : []),
    join(opts.home, "Library/Application Support/Toolbelt/plugins"),
    ...(opts.bundled ? [opts.bundled] : []),
  ];
}
