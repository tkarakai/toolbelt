import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  cpSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import {
  CAPABILITIES,
  LIMITS,
  parsePackageManifest,
  safeRelative,
  type PackageManifest,
} from "../shared/package";

export type Installed = {
  id: string;
  repo: string;
  version: string;
  hash: string;
  packageRoot: string;
  enabled: boolean;
  manifest: PackageManifest;
  channel: "stable" | "prerelease";
  release?: string;
  asset?: string;
  removed?: boolean;
};
export type Registry = {
  formatVersion: 1;
  plugins: Record<string, Installed>;
  seeded?: boolean;
};
export type ReleaseDescriptor = {
  formatVersion: 1;
  id: string;
  version: string;
  repo: string;
  commit: string;
  packages: { target: string; asset: string; sha256: string; size: number }[];
};
export type Candidate = {
  manifest: PackageManifest;
  hash: string;
  packageRoot: string;
  repo: string;
  release?: string;
  asset?: string;
};
export type RuntimeHooks = {
  prepare(id: string, reason: string): Promise<void>;
  stop(id: string): Promise<void>;
  probe(candidate: Candidate, dataDir: string): Promise<void>;
  activate(installed: Installed): Promise<void>;
  remove(id: string): void;
};
const hash = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export function atomicJSON(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}
export function readRegistry(root: string): Registry {
  const file = join(root, "plugins/registry.json");
  if (!existsSync(file)) return { formatVersion: 1, plugins: {} };
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (
    value.formatVersion !== 1 ||
    !value.plugins ||
    typeof value.plugins !== "object"
  )
    throw new Error("Invalid plugin registry");
  return value;
}
export function checkCompatibility(m: PackageManifest, hostVersion = "0.1.0") {
  if (!Bun.semver.satisfies(hostVersion, m.requires.host))
    throw new Error("Plugin requires another Toolbelt host version");
  if (!Bun.semver.satisfies(Bun.version, m.requires.bun))
    throw new Error("Plugin requires another Bun version");
  if (
    !m.requires.platforms.includes("portable") &&
    !m.requires.platforms.includes(`${process.platform}-${process.arch}`)
  )
    throw new Error("Unsupported plugin platform");
  const missing = m.capabilities.required.filter(
    (c) => !(CAPABILITIES as readonly string[]).includes(c),
  );
  if (missing.length)
    throw new Error(`Unsupported required capabilities: ${missing.join(", ")}`);
}
/** Bounded tar reader. Reject links, special files, duplicate paths and extension headers. No publisher code executes. */
export function extractArchive(bytes: Uint8Array, target: string) {
  if (bytes.length > LIMITS.archiveBytes) throw new Error("Archive byte limit");
  const tar = gunzipSync(bytes, { maxOutputLength: LIMITS.expandedBytes });
  const seen = new Set<string>();
  let files = 0;
  let offset = 0;
  mkdirSync(target, { recursive: true });
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((x) => x === 0)) break;
    const text = (a: number, n: number) =>
      header
        .subarray(a, a + n)
        .toString()
        .split("\0")[0]!;
    const stored = parseInt(text(148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (stored !== sum) throw new Error("Invalid tar checksum");
    let name = [text(345, 155), text(0, 100)].filter(Boolean).join("/");
    while (name.startsWith("./")) name = name.slice(2);
    const type = text(156, 1) || "0";
    if (name === "" && type === "5") continue;
    if (type === "5") name = name.replace(/\/$/, "");
    safeRelative(name);
    if (seen.has(name) || ++files > LIMITS.files)
      throw new Error("Duplicate path or file limit");
    seen.add(name);
    if (!["0", "5"].includes(type))
      throw new Error("Archive links/special files are unsupported");
    const size = parseInt(text(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length)
      throw new Error("Invalid tar size");
    const path = join(target, name);
    if (type === "5") mkdirSync(path, { recursive: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, tar.subarray(offset, offset + size), {
        mode: parseInt(text(100, 8).trim() || "644", 8) & 0o777,
      });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (offset > tar.length || !existsSync(join(target, "toolbelt.json")))
    throw new Error("Incomplete plugin archive");
}
function validateFiles(root: string, m: PackageManifest) {
  for (const relative of [
    m.entry,
    ...Object.values(m.assets ?? {}),
    ...(m.migration ? [m.migration.entry] : []),
  ]) {
    safeRelative(relative);
    const path = join(root, relative);
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw new Error(`Missing package file: ${relative}`);
  }
}
export class PackageManager {
  private operations = new Map<string, Promise<unknown>>();
  constructor(
    readonly root: string,
    private hooks: RuntimeHooks,
    private hostVersion = "0.1.0",
  ) {}
  registry() {
    return readRegistry(this.root);
  }
  private save(registry: Registry) {
    atomicJSON(join(this.root, "plugins/registry.json"), registry);
  }
  private serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.operations.set(id, current);
    void current
      .finally(() => {
        if (this.operations.get(id) === current) this.operations.delete(id);
      })
      .catch(() => {});
    return current;
  }
  async stage(
    bytes: Uint8Array,
    expectedHash: string,
    repo: string,
  ): Promise<Candidate> {
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(bytes) !== expectedHash)
      throw new Error("Plugin archive checksum mismatch");
    const dir = join(this.root, "plugins/staging", randomUUID());
    try {
      extractArchive(bytes, dir);
      const manifest = parsePackageManifest(
        JSON.parse(readFileSync(join(dir, "toolbelt.json"), "utf8")),
      );
      checkCompatibility(manifest, this.hostVersion);
      validateFiles(dir, manifest);
      if (manifest.repo.toLowerCase() !== repo.toLowerCase())
        throw new Error("Package publisher/repository mismatch");
      const registry = this.registry();
      const old = registry.plugins[manifest.id];
      if (old && old.repo.toLowerCase() !== repo.toLowerCase())
        throw new Error("Plugin id belongs to another publisher");
      if (old && old.version === manifest.version && old.hash !== expectedHash)
        throw new Error("Installed version asset bytes changed");
      const packageRoot = join(
        this.root,
        "plugins/packages",
        manifest.id,
        `${manifest.version}-${expectedHash}`,
      );
      mkdirSync(dirname(packageRoot), { recursive: true });
      if (!existsSync(packageRoot)) renameSync(dir, packageRoot);
      else rmSync(dir, { recursive: true, force: true });
      const cache = join(this.root, "cache/packages");
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, expectedHash), bytes);
      return { manifest, repo, hash: expectedHash, packageRoot };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  async install(candidate: Candidate, approved: boolean) {
    if (!approved)
      throw new Error("Explicit publisher execution approval required");
    return this.serialize(candidate.manifest.id, async () => {
      const id = candidate.manifest.id,
        registry = this.registry(),
        old = registry.plugins[id];
      if (old && old.repo.toLowerCase() !== candidate.repo.toLowerCase())
        throw new Error("Publisher binding mismatch");
      if (
        old &&
        old.version === candidate.manifest.version &&
        old.hash !== candidate.hash
      )
        throw new Error("Installed version asset bytes changed");
      const cli = candidate.manifest.cli?.command;
      if (
        cli &&
        Object.values(registry.plugins).some(
          (p) => p.id !== id && !p.removed && p.manifest.cli?.command === cli,
        )
      )
        throw new Error("Plugin CLI command collision");
      const tx = randomUUID(),
        txDir = join(this.root, "plugins/transactions", tx),
        data = join(this.root, "data", id),
        backup = join(this.root, "backups", id, tx),
        staged = join(txDir, "data");
      mkdirSync(txDir, { recursive: true });
      mkdirSync(dirname(backup), { recursive: true });
      const next: Installed = {
        id,
        repo: candidate.repo,
        version: candidate.manifest.version,
        hash: candidate.hash,
        packageRoot: candidate.packageRoot,
        manifest: candidate.manifest,
        enabled: true,
        channel: old?.channel ?? "stable",
        release: candidate.release,
        asset: candidate.asset,
      };
      const previous = join(txDir, "previous");
      let promoted = false;
      let movedOriginal = false;
      const journal = {
        id,
        old,
        next,
        data,
        backup,
        staged,
        previous,
        phase: "prepared",
      };
      atomicJSON(join(txDir, "journal.json"), journal);
      let prepared = false;
      try {
        await this.hooks.prepare(id, "upgrade");
        prepared = true;
        await this.hooks.stop(id);
        if (existsSync(data)) {
          cpSync(data, backup, { recursive: true });
          cpSync(data, staged, { recursive: true });
        } else mkdirSync(staged, { recursive: true });
        await this.migrate(candidate, old, staged, backup, tx);
        await this.hooks.probe(candidate, staged);
        journal.phase = "promoting";
        atomicJSON(join(txDir, "journal.json"), journal);
        mkdirSync(dirname(data), { recursive: true });
        if (existsSync(data)) {
          renameSync(data, previous);
          movedOriginal = true;
        }
        renameSync(staged, data);
        promoted = true;
        await this.hooks.activate(next);
        const fresh = this.registry();
        fresh.plugins[id] = next;
        this.save(fresh);
        journal.phase = "committed";
        atomicJSON(join(txDir, "journal.json"), journal);
        rmSync(txDir, { recursive: true, force: true });
        return next;
      } catch (error) {
        if (!prepared) {
          rmSync(txDir, { recursive: true, force: true });
          throw error;
        }
        await this.hooks.stop(id);
        if (promoted) rmSync(data, { recursive: true, force: true });
        if (movedOriginal && existsSync(previous)) renameSync(previous, data);
        const fresh = this.registry();
        if (old) {
          fresh.plugins[id] = old;
          this.save(fresh);
          if (old.enabled) await this.hooks.activate(old);
        } else {
          delete fresh.plugins[id];
          this.save(fresh);
          this.hooks.remove(id);
        }
        rmSync(txDir, { recursive: true, force: true });
        throw error;
      }
    });
  }
  private async migrate(
    candidate: Candidate,
    old: Installed | undefined,
    targetDir: string,
    sourceDir: string,
    transactionId: string,
  ) {
    const m = candidate.manifest;
    if (old?.manifest.data.schema === m.data.schema) return;
    if (!m.migration) {
      if (!old) return;
      throw new Error("Schema change requires migration entrypoint");
    }
    const proc = Bun.spawn(
      [process.execPath, join(candidate.packageRoot, m.migration.entry)],
      {
        cwd: candidate.packageRoot,
        detached: true,
        env: runtimeEnv(candidate, targetDir),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    proc.stdin.write(
      JSON.stringify({
        type: "migrate",
        transactionId,
        fromVersion: old?.version ?? null,
        toVersion: m.version,
        fromSchema: old?.manifest.data.schema ?? null,
        toSchema: m.data.schema,
        sourceDir,
        targetDir,
      }) + "\n",
    );
    proc.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          const [stdout, error] = await Promise.all([
            boundedText(proc.stdout, LIMITS.logs),
            boundedText(proc.stderr, LIMITS.logs),
          ]);
          const code = await proc.exited;
          const messages = stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          if (code || messages.at(-1)?.type !== "migration-complete")
            throw new Error(`Migration failed: ${error || stdout}`);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Migration timed out")),
            LIMITS.migrationMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill();
      }
    }
  }
  async enabled(id: string, enabled: boolean) {
    return this.serialize(id, async () => {
      const registry = this.registry(),
        p = registry.plugins[id];
      if (!p || p.removed) throw new Error("Plugin not installed");
      if (enabled) {
        checkCompatibility(p.manifest, this.hostVersion);
        await this.hooks.activate(p);
      } else {
        await this.hooks.prepare(id, "disable");
        await this.hooks.stop(id);
        this.hooks.remove(id);
      }
      p.enabled = enabled;
      const fresh = this.registry();
      fresh.plugins[id] = p;
      this.save(fresh);
    });
  }
  async remove(id: string, deleteData = false) {
    return this.serialize(id, async () => {
      const registry = this.registry(),
        p = registry.plugins[id];
      if (!p) return;
      await this.hooks.prepare(id, "remove");
      await this.hooks.stop(id);
      this.hooks.remove(id);
      p.enabled = false;
      p.removed = true;
      const fresh = this.registry();
      fresh.plugins[id] = p;
      this.save(fresh);
      if (deleteData)
        rmSync(join(this.root, "data", id), {
          recursive: true,
          force: true,
        }); /* Retain immutable code for independently running CLI helpers. */
    });
  }
  async recover() {
    const root = join(this.root, "plugins/transactions");
    if (!existsSync(root)) return;
    for (const tx of readdirSync(root)) {
      const txDir = join(root, tx),
        file = join(txDir, "journal.json");
      if (!existsSync(file)) {
        rmSync(txDir, { recursive: true, force: true });
        continue;
      }
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j.phase !== "committed") {
        if (j.phase === "promoting") {
          if (existsSync(j.previous)) {
            rmSync(j.data, { recursive: true, force: true });
            renameSync(j.previous, j.data);
          } else if (!j.old) rmSync(j.data, { recursive: true, force: true });
        }
        const registry = this.registry();
        if (j.old) registry.plugins[j.id] = j.old;
        else delete registry.plugins[j.id];
        this.save(registry);
      }
      rmSync(txDir, { recursive: true, force: true });
    }
  }
}
export async function boundedText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
) {
  let text = "";
  for await (const chunk of stream) {
    text += new TextDecoder().decode(chunk);
    if (Buffer.byteLength(text) > limit) throw new Error("Output byte limit");
  }
  return text;
}
export function runtimeEnv(
  candidate: Pick<Candidate, "manifest" | "packageRoot">,
  data: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "USER",
    "TOOLBELT_CONFIG_DIR",
    "TOOLBELT_PS_HOME",
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  return {
    ...env,
    TOOLBELT_PLUGIN: candidate.manifest.id,
    TOOLBELT_PLUGIN_VERSION: candidate.manifest.version,
    TOOLBELT_PROTOCOL: "1",
    TOOLBELT_PACKAGE_ROOT: candidate.packageRoot,
    TOOLBELT_DATA_DIR: data,
  };
}
