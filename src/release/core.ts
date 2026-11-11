import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  SDK_VERSION,
  parsePackageManifest,
  type PackageManifest,
} from "../shared/package";
import {
  extractArchive,
  checkCompatibility,
  PackageManager,
} from "../bun/packages";
import { validatePackage } from "../sdk/package";
import { pluginAsset } from "../bun/plugin-assets";
import { PluginHost, PluginProcess } from "../bun/host";

export type Product = "app" | "sdk" | "plugin";
export type Channel = "stable" | "prerelease";
export type Request = {
  format: 1;
  repo: string;
  product: Product;
  version: string;
  channel: Channel;
};
export type ReleaseConfig = {
  repo: string;
  products: Partial<
    Record<
      Product,
      {
        changelog: string;
        version(): string;
        setVersion(version: string): Promise<void>;
        build(): Promise<string[]>;
      }
    >
  >;
  hostVersion: string;
};
export type RecordFile = { name: string; size: number; sha256: string };
export type ReleaseRecord = Request & {
  source: string;
  tooling: string;
  files: RecordFile[];
  notes: string;
};
export const requestFile = ".toolbelt-release.json";
export const hash = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const json = <T = any>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8"));
export function save(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
export async function run(
  args: string[],
  cwd = process.cwd(),
  env = process.env,
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code)
    throw new Error(
      `${args.slice(0, 3).join(" ")} failed (${code}): ${stderr || stdout}`,
    );
  return stdout.trim();
}
export const tagOf = (r: Request) =>
  `${r.product === "sdk" ? "sdk-v" : "v"}${r.version}`;
export function validateRequest(
  value: unknown,
  config: ReleaseConfig,
): Request {
  const r = value as Request;
  if (
    !r ||
    r.format !== 1 ||
    r.repo !== config.repo ||
    !["app", "sdk", "plugin"].includes(r.product) ||
    !config.products[r.product]
  )
    throw Error("Invalid release product/repository");
  if (
    typeof r.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      r.version,
    ) ||
    r.version
      .split("-")
      .slice(1)
      .join("-")
      .split(".")
      .some((p) => (!p && r.version.includes("-")) || /^0[0-9]+$/.test(p))
  )
    throw Error("Expected a semantic version without build metadata");
  if (
    !["stable", "prerelease"].includes(r.channel) ||
    r.version.includes("-") !== (r.channel === "prerelease")
  )
    throw Error(
      "Stable requires a final version; prerelease requires a prerelease version",
    );
  return r;
}
export function releaseNotes(text: string, version: string) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} — `));
  if (start < 0) throw Error(`Missing changelog section for ${version}`);
  const next = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const notes = lines
    .slice(start + 1, next < 0 ? undefined : next)
    .join("\n")
    .trim();
  if (!notes.replace(/^#+.*$/gm, "").trim())
    throw Error("Release notes must describe changes");
  return notes;
}
export function prepareNotes(text: string, version: string) {
  const match = /^## Unreleased\s*$/m.exec(text);
  if (!match) throw Error("Missing Unreleased changelog section");
  const updated =
    text.slice(0, match.index) +
    `## Unreleased\n\n## ${version} — ${new Date().toISOString().slice(0, 10)}` +
    text.slice(match.index + match[0].length);
  releaseNotes(updated, version);
  return updated;
}
export async function updateJSONVersion(path: string, version: string) {
  const p = json(path);
  p.version = version;
  save(path, p);
}

/** Use the host's actual archive/schema/lifecycle implementation, never a permissive CLI clone. */
export async function verifyPlugin(
  archive: string,
  hostVersion: string,
  expected?: { repo: string; version: string; target: string },
) {
  const root = mkdtempSync(join(tmpdir(), "toolbelt-release-probe-"));
  let plugin: PluginProcess | undefined;
  try {
    const pkg = join(root, "package");
    extractArchive(new Uint8Array(readFileSync(archive)), pkg);
    const m = validatePackage(pkg);
    if (
      expected &&
      (m.repo !== expected.repo ||
        m.version !== expected.version ||
        !m.requires.platforms.includes(expected.target))
    )
      throw Error("Archive identity/target mismatch");
    // Native execution is required only on the package's own target runner.
    if (
      !m.requires.platforms.includes("portable") &&
      !m.requires.platforms.includes(`${process.platform}-${process.arch}`)
    )
      throw Error("Use a native runner for this package target");
    checkCompatibility(m, hostVersion);
    const surfaces = m.screens.map((s) => `screen:${s.id}`);
    if (m.quickView) surfaces.push("quick");
    const environment = {
      HOME: root,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: root,
      TOOLBELT_PS_HOME: root,
      TOOLBELT_CONFIG_DIR: root,
    };
    const host = new PluginHost({
      dirs: [],
      bun: process.execPath,
      env: environment,
      host: { name: "Release probe", version: hostVersion },
      data: join(root, "data"),
    });
    const manager = new PackageManager(
      root,
      {
        async prepare() {},
        async stop() {},
        probe: (candidate, data) => host.probe(candidate, data),
        async activate() {},
        remove() {},
      },
      hostVersion,
      undefined,
      environment,
    );
    const archiveBytes = new Uint8Array(readFileSync(archive));
    const candidate = await manager.stage(
      archiveBytes,
      hash(archiveBytes),
      m.repo,
    );
    await manager.install(candidate, true);
    for (const name of Object.keys(m.assets ?? {}))
      if (!pluginAsset(manager, `asset:${m.id}@${m.version}/${name}`))
        throw Error(`Invalid display asset: ${name}`);
    // Render from the verified installed selection and initialized/migrated disposable data.
    plugin = new PluginProcess(
      m,
      candidate.packageRoot,
      {
        bun: process.execPath,
        env: {
          HOME: root,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: root,
          TOOLBELT_PS_HOME: root,
          TOOLBELT_CONFIG_DIR: root,
        },
        host: { name: "Toolbelt release verifier", version: hostVersion },
        data: join(root, "data"),
        configRoot: root,
        mode: "probe",
      },
      () => {},
      { plugins() {}, tree() {}, toast() {} },
    );
    plugin.start();
    await plugin.waitReady();
    for (const surface of surfaces) plugin.open(surface);
    const deadline = Date.now() + 10000;
    while (surfaces.some((s) => !plugin!.trees.has(s))) {
      if (plugin.state === "crashed" || Date.now() > deadline)
        throw Error(
          plugin.error || "Package did not render all declared surfaces",
        );
      await Bun.sleep(20);
    }
    await plugin.prepare("upgrade");
    return m;
  } finally {
    if (plugin) await plugin.stopAndWait();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Generic packaging; adapters only produce ready-to-run folders and specialized extras. */
export async function packagePlugin(
  root: string,
  output: string,
  hostVersion: string,
  extras: string[] = [],
) {
  const m = validatePackage(root);
  mkdirSync(output, { recursive: true });
  const packages = [];
  const paths = [...extras];
  for (const target of m.requires.platforms) {
    const asset = `${m.repo.split("/")[1]}-${m.version}-${target}.tar.gz`;
    const path = resolve(output, asset);
    await run(
      ["tar", "--format=ustar", "-czf", path, "-C", resolve(root), "."],
      process.cwd(),
      { ...process.env, COPYFILE_DISABLE: "1" },
    );
    // Always validate bounded extraction, including cross-target archives.
    const temp = mkdtempSync(join(tmpdir(), "toolbelt-archive-"));
    try {
      extractArchive(new Uint8Array(readFileSync(path)), temp);
      validatePackage(temp);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    if (
      target === "portable" ||
      target === `${process.platform}-${process.arch}`
    )
      await verifyPlugin(path, hostVersion, {
        repo: m.repo,
        version: m.version,
        target,
      });
    const bytes = readFileSync(path);
    packages.push({ target, asset, sha256: hash(bytes), size: bytes.length });
    writeFileSync(`${path}.sha256`, `${hash(bytes)}  ${asset}\n`);
    paths.push(path, `${path}.sha256`);
  }
  const descriptor = resolve(output, "toolbelt-release.json");
  save(descriptor, {
    formatVersion: 1,
    id: m.id,
    repo: m.repo,
    version: m.version,
    commit: await run(["git", "rev-parse", "HEAD"]),
    packages,
  });
  return [...paths, descriptor];
}
export function freeze(
  request: Request,
  source: string,
  paths: string[],
  notes: string,
  output: string,
): ReleaseRecord {
  if (!/^[0-9a-f]{40}$/.test(source) || !paths.length)
    throw Error("Invalid source or empty candidate");
  if (existsSync(output))
    throw Error(
      "Candidate directory already exists; reuse it or choose a fresh staging directory",
    );
  mkdirSync(output, { recursive: true });
  const names = paths.map((p) => basename(p));
  if (
    new Set(names).size !== names.length ||
    names.includes("release-record.json")
  )
    throw Error("Duplicate/reserved artifact name");
  const files = paths.map((path) => {
    const bytes = readFileSync(path);
    cpSync(path, join(output, basename(path)));
    return { name: basename(path), size: bytes.length, sha256: hash(bytes) };
  });
  const record = { ...request, source, tooling: SDK_VERSION, files, notes };
  save(join(output, "release-record.json"), record);
  return record;
}
export function verifyFrozen(directory: string, config: ReleaseConfig) {
  const record = json<ReleaseRecord>(join(directory, "release-record.json"));
  validateRequest(record, config);
  if (
    !/^[0-9a-f]{40}$/.test(record.source) ||
    !record.tooling ||
    !record.notes ||
    !Array.isArray(record.files) ||
    !record.files.length
  )
    throw Error("Invalid release record");
  const names = new Set<string>();
  for (const f of record.files) {
    if (
      !f.name ||
      basename(f.name) !== f.name ||
      f.name === "release-record.json" ||
      names.has(f.name)
    )
      throw Error("Invalid artifact name");
    names.add(f.name);
    const bytes = readFileSync(join(directory, f.name));
    if (bytes.length !== f.size || hash(bytes) !== f.sha256)
      throw Error(`Frozen bytes changed: ${f.name}`);
  }
  return record;
}
export function pluginManifest(): PackageManifest {
  return parsePackageManifest(json("toolbelt.json"));
}
