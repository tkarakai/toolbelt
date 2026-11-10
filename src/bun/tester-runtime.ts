import { mkdirSync, realpathSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PluginHost } from "./host";
import { PackageManager } from "./packages";

export function testerProfile(name = "default", base = join(homedir(), "Library/Application Support/Toolbelt Plugin Tester")) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid tester profile name");
  return join(base, "profiles", name);
}
export type TesterDiagnostic = { time: string; kind: string; detail: unknown };
/** Owns only a tester profile. Package parsing, execution and migrations remain production code. */
export class TesterRuntime {
  readonly host: PluginHost;
  readonly packages: PackageManager;
  readonly diagnostics: TesterDiagnostic[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, version: string, bun = process.execPath) {
    mkdirSync(root, { recursive: true });
    this.host = new PluginHost({ registryRoot: root, dirs: [], bun, host: { name: "Toolbelt Plugin Tester", version }, data: join(root, "data"), env: {} });
    this.packages = new PackageManager(root, {
      prepare: (id, reason) => this.host.prepare(id, reason), stop: id => this.host.stopPlugin(id),
      probe: (candidate, data) => this.host.probe(candidate, data), activate: p => this.host.activate(p), remove: id => this.host.remove(id),
    }, version);
    this.host.subscribe({ plugins: list => this.record("lifecycle", list), tree: (plugin, surface, tree) => this.record("validated-render", {plugin, surface, tree}), toast: (plugin, text) => this.record("toast", {plugin, text}) });
  }
  record(kind: string, detail: unknown) {
    // Bound both record count and individual diagnostic payload size.
    const encoded = JSON.stringify(detail);
    this.diagnostics.push({ time: new Date().toISOString(), kind, detail: encoded.length > 16000 ? encoded.slice(0, 16000) + "…" : detail });
    if (this.diagnostics.length > 200) this.diagnostics.shift();
  }
  async start() { await this.packages.recover(); this.host.start(); }
  load(archive: string, repo: string, approved: boolean) {
    const task = this.tail.catch(() => {}).then(async () => {
      this.record("archive", {archive, repo});
      try {
        const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
        const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const candidate = await this.packages.stage(bytes, hash, repo);
        await this.packages.install(candidate, approved);
        this.record("installed", { id: candidate.manifest.id, hash });
      } catch (error) { this.record("error", String(error)); throw error; }
    });
    this.tail = task;
    return task;
  }
  /** Watch only explicitly selected built output; never source-build or execute a build command. */
  watchArchive(directory: string, filename: string, repo: string) {
    if (!filename.endsWith(".tar.gz") || filename.includes("/") || filename.includes("\\")) throw new Error("Select an archive filename");
    const dir = realpathSync(directory);
    let timer: ReturnType<typeof setTimeout>;
    const watcher = watch(dir, (_event, name) => {
      if (name !== filename) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const archive = resolve(dir, filename);
        try { if (realpathSync(archive).startsWith(dir + "/")) void this.load(archive, repo, true).catch(() => {}); } catch (error) { this.record("watch-error", String(error)); }
      }, 300);
    });
    this.record("DEV WATCH — execution approved", {dir, filename, repo});
    return () => { clearTimeout(timer); watcher.close(); };
  }
  async reset(id: string) {
    if (!this.packages.registry().plugins[id]) throw new Error("Unknown plugin");
    await this.packages.remove(id, true);
    this.record("reset", id);
    // Package remains available, but initialization/migration must run again via load.
  }
  async stop() {
    await this.tail.catch(() => {});
    for (const p of this.host.list()) await this.host.stopPlugin(p.manifest.id);
  }
}
