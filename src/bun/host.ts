// Finds plugins, starts each as a Bun child process, and relays its UI trees to the web views.
// No Electrobun imports here, so it can be tested on its own.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PROTOCOL_VERSION,
  parseManifest,
  splitLines,
  type HostMessage,
  type Manifest,
  type Node,
  type PluginMessage,
} from "../shared/protocol";
import {
  LIMITS,
  CAPABILITIES,
  parsePackageManifest,
  type PackageManifest,
} from "../shared/package";
import { validateMessage, validateEventPayload } from "../shared/validation";
import {
  runtimeEnv,
  type Candidate,
  type Installed,
  readRegistry,
  checkCompatibility,
} from "./packages";
import type { PluginInfo, PluginState } from "../shared/rpc";

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

type Listener = {
  plugins(list: PluginInfo[]): void;
  tree(plugin: string, surface: string, tree: Node): void;
  toast(
    plugin: string,
    text: string,
    tone?: "default" | "success" | "error",
    action?: { id: string; label: string; payload?: unknown },
  ): void;
  clipboard?(plugin: string, text: string): void;
};

export class PluginProcess {
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private greeted = false;
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
  private stderrWindow = Date.now();
  private stderrBytes = 0;
  waitReady() {
    if (this.state === "running") return Promise.resolve();
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
    if (!proc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      proc.exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
          resolve(null);
        }, 2000);
      }),
    ]);
    clearTimeout(timer);
  }
  state: PluginState = "stopped";
  badge: number | string | null = null;
  error?: string;
  trees = new Map<string, Node>();
  /** Surface → how many viewers have it open. */
  viewers = new Map<string, number>();
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
    },
    private readonly changed: () => void,
    private readonly listener: Listener,
  ) {}

  info(): PluginInfo {
    return {
      manifest: this.manifest,
      state: this.state,
      badge: this.badge,
      error: this.error,
    };
  }

  start() {
    this.stopping = false;
    this.greeted = false;
    this.startupMessages = [];
    this.state = "starting";
    this.error = undefined;
    this.stderrTail = [];
    const entry = resolve(this.dir, this.manifest.entry);
    const data =
      (this as any).dataOverride ?? join(this.opts.data, this.manifest.id);
    try {
      mkdirSync(data, { recursive: true });
    } catch (e) {
      this.log(`can't create its data folder ${data}: ${(e as Error).message}`);
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
    if (this.proc) {
      try {
        process.kill(-this.proc.pid, "SIGTERM");
      } catch {
        this.proc.kill();
      }
    }
  }

  restart() {
    this.stop();
    this.restarts = 0;
    this.restartTimer = setTimeout(() => this.start(), 200);
  }

  send(msg: HostMessage) {
    const stdin = this.proc?.stdin as import("bun").FileSink | undefined;
    if (!stdin || this.state === "crashed") return;
    try {
      this.opts.diagnostic?.(this.manifest.id, "host-message", msg);
      stdin.write(JSON.stringify(msg) + "\n");
      stdin.flush();
    } catch {}
  }

  open(surface: string) {
    const n = (this.viewers.get(surface) ?? 0) + 1;
    this.viewers.set(surface, n);
    if (n === 1 && this.state === "running")
      this.send({ type: "open", surface });
    return this.trees.get(surface) ?? null;
  }

  close(surface: string) {
    const n = Math.max(0, (this.viewers.get(surface) ?? 0) - 1);
    this.viewers.set(surface, n);
    if (n === 0) this.send({ type: "close", surface });
  }

  private async read(
    stream: ReadableStream<Uint8Array>,
    proc: ReturnType<typeof Bun.spawn>,
  ) {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      if (this.proc !== proc || this.stopping) return;
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
          validateMessage(msg);
        } catch {
          this.fail(`Invalid protocol message`);
          return;
        }
        this.opts.diagnostic?.(
          this.manifest.id,
          "plugin-message",
          line.slice(0, 16000),
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
    this.readyReject?.(new Error(error));
    this.readyReject = undefined;
    this.stop();
    this.state = "crashed";
    this.error = error;
    this.changed();
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
      for (const [surface, n] of this.viewers)
        if (n > 0) this.send({ type: "open", surface });
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
        {
          const check = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
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
        }
        if (
          !this.manifest.screens.some(
            (s) => `screen:${s.id}` === msg.surface,
          ) &&
          !(this.manifest.quickView && msg.surface === "quick")
        ) {
          this.fail("Undeclared surface");
          return;
        }
        this.trees.set(msg.surface, msg.tree);
        this.listener.tree(this.manifest.id, msg.surface, msg.tree);
        break;
      case "badge":
        this.badge = msg.value;
        this.changed();
        break;
      case "toast":
        this.listener.toast(this.manifest.id, msg.text, msg.tone, msg.action);
        break;
      case "clipboard":
        this.listener.clipboard?.(this.manifest.id, msg.text);
        break;
    }
  }

  private exited(proc: ReturnType<typeof Bun.spawn>, code: number | null) {
    if (proc !== this.proc) return; // an older process after a restart
    clearTimeout(this.handshakeTimer);
    this.readyReject?.(new Error("Plugin exited before ready"));
    this.readyReject = undefined;
    if (this.stopping) {
      if (this.state !== "crashed") this.state = "stopped";
      this.changed();
      return;
    }
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
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
    },
  ) {}

  start() {
    const entries = this.opts.registryRoot
      ? Object.values(readRegistry(this.opts.registryRoot).plugins)
          .filter((p) => p.enabled && !p.removed)
          .map((p) => ({ manifest: p.manifest, dir: p.packageRoot }))
      : discover(this.opts.dirs);
    for (const { manifest, dir } of entries) {
      const p = this.makeProcess(manifest, dir, this.opts.data);
      this.plugins.set(manifest.id, p);
      try {
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

  open(plugin: string, surface: string) {
    return this.get(plugin).open(surface);
  }

  close(plugin: string, surface: string) {
    this.plugins.get(plugin)?.close(surface);
  }

  event(plugin: string, surface: string, name: string, payload?: unknown) {
    if (
      typeof name !== "string" ||
      name.length > 256 ||
      typeof surface !== "string" ||
      surface.length > 256
    )
      throw new Error("Invalid event metadata");
    validateEventPayload(payload);
    this.get(plugin).send({ type: "event", surface, name, payload });
  }

  restart(plugin: string) {
    this.get(plugin).restart();
  }

  async prepare(id: string, reason: string) {
    await this.plugins.get(id)?.prepare(reason);
  }
  async stopPlugin(id: string) {
    await this.plugins.get(id)?.stopAndWait();
  }
  remove(id: string) {
    this.plugins.get(id)?.stop();
    this.plugins.delete(id);
    this.emitPlugins();
  }
  async activate(installed: Installed) {
    this.remove(installed.id);
    const p = this.makeProcess(
      installed.manifest,
      installed.packageRoot,
      this.opts.data,
    );
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
      },
      () => this.emitPlugins(),
      {
        plugins: () => {},
        tree: (plugin, surface, tree) =>
          this.listeners.forEach((l) => {
            try {
              l.tree(plugin, surface, tree);
            } catch {}
          }),
        toast: (plugin, text, tone, action) =>
          this.listeners.forEach((l) => {
            try {
              l.toast(plugin, text, tone, action);
            } catch {}
          }),
        clipboard: (plugin, text) =>
          this.listeners.forEach((l) => {
            try {
              l.clipboard?.(plugin, text);
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
