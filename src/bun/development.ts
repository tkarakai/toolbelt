// Plugin development mode (docs/plugin-development.md): named profiles, local archives,
// watch and bounded diagnostics. Package validation and activation stay in PackageManager.
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { atomicJSON, extractArchive, type PackageManager } from "./packages";
import type {
  DevelopmentDiagnostic,
  DevelopmentRequest,
  DevelopmentResponse,
  DevelopmentState,
} from "../shared/development";

/** Selects development mode at launch; absent means normal mode. */
export const DEVELOPMENT_ENV = "TOOLBELT_DEVELOPMENT_PROFILE";
const PROFILE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function developmentProfileName(name: unknown): string {
  if (typeof name !== "string" || !PROFILE_NAME.test(name))
    throw new Error(
      "Profile names use letters, digits, underscores and dashes (up to 64)",
    );
  return name;
}
export const developmentRoot = (configRoot: string, name: string) =>
  join(configRoot, "development", developmentProfileName(name));

export function developmentProfiles(configRoot: string): string[] {
  const dir = join(configRoot, "development");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export type Diagnostic = DevelopmentDiagnostic;
/** Bounds both the number of records and each record's payload. */
export class DiagnosticLog {
  readonly entries: Diagnostic[] = [];
  constructor(private limit = 200, private bytes = 16_000) {}
  record(kind: string, detail: unknown) {
    const encoded = JSON.stringify(detail) ?? "null";
    this.entries.push({
      time: new Date().toISOString(),
      kind,
      detail:
        encoded.length > this.bytes ? encoded.slice(0, this.bytes) + "…" : detail,
    });
    if (this.entries.length > this.limit) this.entries.shift();
  }
}


/** The folder a typed path names: a file's folder, or the folder itself. Null if neither exists. */
export function folderOf(path: string | undefined, home = homedir()): string | null {
  const typed = path?.trim();
  if (!typed) return null;
  const absolute = typed === "~" ? home : typed.startsWith("~/") ? join(home, typed.slice(2)) : typed;
  if (!absolute.startsWith("/")) return null;
  try {
    const stat = statSync(absolute);
    if (stat.isDirectory()) return absolute;
    if (stat.isFile()) return dirname(absolute);
  } catch {}
  return null;
}

/**
 * The manifest's publisher, to prefill the form after choosing an archive. Uses the bounded
 * production extractor in a scratch folder; nothing is installed or executed. Null if unreadable.
 */
export async function archivePublisher(archive: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-archive-"));
  try {
    extractArchive(new Uint8Array(await Bun.file(archive).arrayBuffer()), dir);
    const repo = JSON.parse(readFileSync(join(dir, "toolbelt.json"), "utf8"))?.repo;
    return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
/** Where a local plugin came from, and whether rebuilds of that archive install automatically. */
export type LocalSource = { archive: string; repo: string; watching: boolean };

/**
 * Installs explicitly selected built archives; never builds sources or installs dependencies.
 * Each installed local plugin remembers its archive in `<profile>/development-sources.json`;
 * watched archives reload on change and resume when the profile opens again.
 */
export class LocalArchives {
  private tail: Promise<unknown> = Promise.resolve();
  private watchers = new Map<string, () => void>();
  private sources: Record<string, LocalSource> = {};
  private file: string;
  constructor(
    readonly packages: PackageManager,
    readonly log: DiagnosticLog,
    private changed: () => void = () => {},
  ) {
    this.file = join(packages.root, "development-sources.json");
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const [id, value] of Object.entries(saved ?? {})) {
        const v = value as Partial<LocalSource>;
        if (
          typeof v.archive === "string" && v.archive.endsWith(".tar.gz") && v.archive.startsWith("/") &&
          typeof v.repo === "string" && REPO.test(v.repo)
        )
          this.sources[id] = { archive: v.archive, repo: v.repo, watching: v.watching === true };
      }
    } catch {}
  }
  private save() {
    atomicJSON(this.file, this.sources);
  }
  private installed(id: string) {
    const p = this.packages.registry().plugins[id];
    return !!p && !p.removed;
  }
  /** Sources of local plugins still installed in this profile. */
  list(): ({ id: string } & LocalSource)[] {
    return Object.entries(this.sources)
      .filter(([id]) => this.installed(id))
      .map(([id, source]) => ({ id, ...source }));
  }
  /** Starts the watches saved for installed plugins (when the development profile opens). */
  resume() {
    for (const { id, watching } of this.list()) {
      if (!watching) continue;
      try {
        this.startWatch(id);
      } catch (error) {
        this.sources[id]!.watching = false;
        this.log.record("watch-error", { id, error: String(error) });
      }
    }
    this.save();
  }
  load(archive: string, repo: string, approved: boolean, options: { watch?: boolean } = {}) {
    const task = this.tail
      .catch(() => {})
      .then(async () => {
        if (!approved)
          throw new Error("Explicit publisher execution approval required");
        if (typeof archive !== "string" || !archive.endsWith(".tar.gz"))
          throw new Error("Select a built .tar.gz plugin archive");
        if (typeof repo !== "string" || !REPO.test(repo))
          throw new Error("Enter the publisher repository as owner/repo");
        this.log.record("archive", { archive, repo });
        try {
          const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
          const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
          const candidate = await this.packages.stage(bytes, hash, repo, {
            local: true,
          });
          const old = this.packages.registry().plugins[candidate.manifest.id];
          if (old && old.version === candidate.manifest.version && old.hash !== hash)
            this.log.record("rebuild", {
              id: old.id,
              version: old.version,
              from: old.hash,
              to: hash,
            });
          await this.packages.install(candidate, true);
          const id = candidate.manifest.id;
          const result = { id, version: candidate.manifest.version, hash };
          this.log.record("installed", result);
          this.remember(id, archive, repo, options.watch);
          return result;
        } catch (error) {
          this.log.record("error", String(error));
          throw error;
        } finally {
          this.changed();
        }
      });
    this.tail = task;
    return task;
  }
  /** Records the archive behind `id`; a changed path moves an active watch to it. */
  private remember(id: string, archive: string, repo: string, watch?: boolean) {
    const path = resolve(archive);
    const previous = this.sources[id];
    const watching = watch ?? previous?.watching ?? false;
    const moved = !previous || previous.archive !== path || previous.repo !== repo;
    this.sources[id] = { archive: path, repo, watching };
    if (watching && (moved || !this.watchers.has(id))) {
      this.stopWatch(id);
      try {
        this.startWatch(id);
      } catch (error) {
        this.sources[id]!.watching = false;
        this.log.record("watch-error", { id, error: String(error) });
      }
    }
    this.save();
  }
  /** Turns automatic reloading of a local plugin's archive on or off. */
  setWatching(id: string, watching: boolean) {
    const source = this.sources[id];
    if (!source || !this.installed(id)) throw new Error("No local archive is recorded for this plugin");
    if (watching) {
      if (!this.watchers.has(id)) this.startWatch(id);
    } else this.stopWatch(id);
    source.watching = watching;
    this.save();
    this.log.record(watching ? "watch" : "unwatch", { id, archive: source.archive });
    this.changed();
  }
  private startWatch(id: string) {
    const { archive } = this.sources[id]!;
    const dir = realpathSync(dirname(archive));
    if (!statSync(dir).isDirectory()) throw new Error("Archive folder missing");
    const filename = basename(archive);
    const path = resolve(dir, filename);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(dir, (_event, name) => {
      if (name !== filename) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // A plugin removed through the manager stops its watch instead of coming back.
        const source = this.sources[id];
        if (!source?.watching) return;
        if (!this.installed(id)) {
          this.stopWatch(id);
          source.watching = false;
          this.save();
          this.changed();
          return;
        }
        try {
          if (!realpathSync(path).startsWith(dir + "/")) return;
        } catch (error) {
          this.log.record("watch-error", { id, error: String(error) });
          return;
        }
        void this.load(path, source.repo, true).catch(() => {});
      }, 300);
    });
    this.watchers.set(id, () => {
      clearTimeout(timer);
      watcher.close();
    });
  }
  private stopWatch(id: string) {
    this.watchers.get(id)?.();
    this.watchers.delete(id);
  }
  /** Stops every watch for this process (mode switch, quit); saved choices are kept. */
  closeWatches() {
    for (const id of [...this.watchers.keys()]) this.stopWatch(id);
  }
  /**
   * Deletes the plugin's managed data and reinstalls it from its recorded archive, so it starts
   * fresh (keeping its watch choice). Without a readable recorded archive it stays removed.
   */
  async reset(id: string) {
    if (!this.packages.registry().plugins[id]) throw new Error("Unknown plugin");
    const source = this.sources[id];
    this.stopWatch(id);
    await this.packages.remove(id, true);
    this.log.record("reset", id);
    this.changed();
    if (source && existsSync(source.archive)) {
      const result = await this.load(source.archive, source.repo, true, { watch: source.watching });
      return { reinstalled: result };
    }
    delete this.sources[id];
    this.save();
    this.changed();
    return { reinstalled: null };
  }
  async settle() {
    await this.tail.catch(() => {});
  }
}

/** One request handler for the app, the browser preview and the debug channel. */
export class DevelopmentController {
  switching = false;
  constructor(
    private o: {
      configRoot: string;
      profile: string | null;
      archives: LocalArchives | null;
      log: DiagnosticLog;
      /** Relaunch into `profile` (null: normal mode). Resolves only if the relaunch failed to start. */
      switchMode: (profile: string | null) => Promise<void>;
      changed: (state: DevelopmentState) => void;
      /** Native file picker: the chosen path, or null when cancelled. */
      chooseArchive?: (startingFolder?: string) => Promise<string | null>;
    },
  ) {}
  state(): DevelopmentState {
    return {
      available: true,
      active: !!this.o.profile,
      profile: this.o.profile,
      profiles: developmentProfiles(this.o.configRoot),
      sources: this.o.archives?.list() ?? [],
      switching: this.switching,
    };
  }
  emit() {
    this.o.changed(this.state());
  }
  private async switchTo(profile: string | null) {
    if (this.switching) throw new Error("ToolBelt is already switching modes");
    if (profile === this.o.profile)
      throw new Error(
        profile ? `Already using development profile ${profile}` : "Already in normal mode",
      );
    this.switching = true;
    this.emit();
    try {
      await this.o.switchMode(profile);
    } finally {
      this.switching = false;
      this.emit();
    }
  }
  private lastFolder?: string;
  private archives() {
    if (!this.o.archives) throw new Error("Switch to development mode first");
    return this.o.archives;
  }
  async request(request: DevelopmentRequest): Promise<DevelopmentResponse> {
    try {
      switch (request?.operation) {
        case "state":
          break;
        case "choose": {
          this.archives();
          if (!this.o.chooseArchive) throw new Error("Choosing files isn't available here; enter the archive path");
          // Start where the typed path points if it exists, else the last chosen folder.
          const archive = await this.o.chooseArchive(folderOf(request.archive) ?? this.lastFolder);
          if (!archive) return { state: this.state() };
          if (!archive.endsWith(".tar.gz")) throw new Error("Choose a built .tar.gz plugin archive");
          this.lastFolder = dirname(archive);
          return { state: this.state(), chosen: { archive, repo: await archivePublisher(archive) } };
        }
        case "enter":
          await this.switchTo(developmentProfileName(request.profile));
          break;
        case "exit":
          if (!this.o.profile) throw new Error("Already in normal mode");
          await this.switchTo(null);
          break;
        case "load": {
          const installed = await this.archives().load(
            request.archive ?? "",
            request.repo ?? "",
            request.approved === true,
            { watch: request.watch === true },
          );
          return { state: this.state(), installed };
        }
        case "watch":
          this.archives().setWatching(request.id ?? "", request.watching === true);
          break;
        case "reset": {
          const { reinstalled } = await this.archives().reset(request.id ?? "");
          return { state: this.state(), ...(reinstalled ? { installed: reinstalled } : {}) };
        }
        case "diagnostics":
          this.archives();
          return { state: this.state(), diagnostics: this.o.log.entries };
        default:
          throw new Error("Unknown development operation");
      }
      return { state: this.state() };
    } catch (error) {
      return {
        state: this.state(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
