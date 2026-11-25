import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DevelopmentController,
  DiagnosticLog,
  LocalArchives,
  developmentProfileName,
  developmentProfiles,
  developmentRoot,
  folderOf,
} from "../src/bun/development";
import { PackageManager, readRegistry, type RuntimeHooks } from "../src/bun/packages";

const manifest = (version: string) => ({
  formatVersion: 1,
  id: "fixture",
  name: "Fixture",
  version,
  repo: "test/fixture",
  entry: "index.js",
  protocol: 2, agent: { access: "read" },
  icon: "box",
  screens: [{ id: "main", title: "Main" }],
  requires: { host: ">=0.1.0", bun: ">=1.3.0", platforms: ["portable"] },
  capabilities: { required: ["ui.core"], optional: [] },
  data: { schema: 1 },
});
/** Builds a real ustar archive; `body` changes the bytes without changing the version. */
async function archive(dir: string, version = "1.0.0", body = "") {
  const source = mkdtempSync(join(dir, "source-"));
  writeFileSync(join(source, "toolbelt.json"), JSON.stringify(manifest(version)));
  writeFileSync(join(source, "index.js"), body);
  const file = join(dir, "fixture.tar.gz");
  const tar = Bun.spawn(["tar", "--format", "ustar", "-czf", file, "-C", source, "toolbelt.json", "index.js"]);
  expect(await tar.exited).toBe(0);
  rmSync(source, { recursive: true, force: true });
  const bytes = new Uint8Array(readFileSync(file));
  return { file, bytes, hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}
const hooks = (events: string[] = []): RuntimeHooks => ({
  prepare: async (id, reason) => void events.push(`prepare:${id}:${reason}`),
  stop: async () => {},
  probe: async () => {},
  activate: async (p) => void events.push(`activate:${p.hash.slice(0, 8)}`),
  remove: () => {},
});
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tb-development-"));
  const root = join(dir, "profile");
  mkdirSync(root);
  return { dir, root };
}

test("profile names stay inside the development folder and list sorted", () => {
  expect(developmentRoot("/scratch", "feat-tags")).toBe("/scratch/development/feat-tags");
  for (const name of ["", "../Toolbelt", "a/b", ".", "x".repeat(65), 7, undefined])
    expect(() => developmentProfileName(name)).toThrow();
  const { dir } = scratch();
  try {
    expect(developmentProfiles(dir)).toEqual([]);
    for (const name of ["zeta", "alpha", "not valid"]) mkdirSync(join(dir, "development", name), { recursive: true });
    writeFileSync(join(dir, "development", "file"), "");
    expect(developmentProfiles(dir)).toEqual(["alpha", "zeta"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normal profiles refuse local archives", async () => {
  const { dir, root } = scratch();
  try {
    const a = await archive(dir);
    const manager = new PackageManager(root, hooks(), "0.1.0");
    await expect(manager.stage(a.bytes, a.hash, "test/fixture", { local: true })).rejects.toThrow("development profile");
    const candidate = await manager.stage(a.bytes, a.hash, "test/fixture");
    await expect(manager.install({ ...candidate, local: true }, true)).rejects.toThrow("development profile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("development profiles replace rebuilt bytes of the same version and keep data", async () => {
  const { dir, root } = scratch();
  try {
    const events: string[] = [];
    const manager = new PackageManager(root, hooks(events), "0.1.0", undefined, undefined, true);
    const first = await archive(dir, "1.0.0", "// one");
    await manager.install(await manager.stage(first.bytes, first.hash, "test/fixture", { local: true }), true);
    writeFileSync(join(root, "data/fixture/state.json"), "kept");
    const second = await archive(dir, "1.0.0", "// two");
    expect(second.hash).not.toBe(first.hash);
    // Released (non-local) bytes keep the strict rule even in a development profile.
    await expect(manager.stage(second.bytes, second.hash, "test/fixture")).rejects.toThrow("bytes changed");
    await manager.install(await manager.stage(second.bytes, second.hash, "test/fixture", { local: true }), true);
    const installed = readRegistry(root).plugins.fixture!;
    expect(installed.hash).toBe(second.hash);
    expect(installed.local).toBe(true);
    expect(installed.version).toBe("1.0.0");
    expect(readFileSync(join(root, "data/fixture/state.json"), "utf8")).toBe("kept");
    expect(events.filter((e) => e.startsWith("activate:"))).toEqual([`activate:${first.hash.slice(0, 8)}`, `activate:${second.hash.slice(0, 8)}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local archives require approval, a repository and the matching publisher", async () => {
  const { dir, root } = scratch();
  try {
    const log = new DiagnosticLog();
    const archives = new LocalArchives(new PackageManager(root, hooks(), "0.1.0", undefined, undefined, true), log);
    const a = await archive(dir);
    await expect(archives.load(a.file, "test/fixture", false)).rejects.toThrow("approval");
    await expect(archives.load(join(dir, "plugin.zip"), "test/fixture", true)).rejects.toThrow(".tar.gz");
    await expect(archives.load(a.file, "not a repo", true)).rejects.toThrow("owner/repo");
    await expect(archives.load(a.file, "other/repo", true)).rejects.toThrow("publisher");
    expect(log.entries.at(-1)?.kind).toBe("error");
    expect(await archives.load(a.file, "test/fixture", true)).toEqual({ id: "fixture", version: "1.0.0", hash: a.hash });
    // Reset deletes the data and reinstalls fresh from the recorded archive.
    writeFileSync(join(root, "data/fixture/state.json"), "old");
    expect((await archives.reset("fixture")).reinstalled?.hash).toBe(a.hash);
    expect(readRegistry(root).plugins.fixture!.removed).toBeUndefined();
    expect(existsSync(join(root, "data/fixture/state.json"))).toBe(false);
    // Without its archive the plugin stays removed and the record is forgotten.
    rmSync(a.file);
    expect((await archives.reset("fixture")).reinstalled).toBeNull();
    expect(readRegistry(root).plugins.fixture!.removed).toBe(true);
    expect(archives.list()).toEqual([]);
    await expect(archives.reset("missing")).rejects.toThrow("Unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each local plugin remembers its archive and watch across instances", async () => {
  const { dir, root } = scratch();
  const waitFor = async (hash: string) => {
    for (let i = 0; i < 50 && readRegistry(root).plugins.fixture?.hash !== hash; i++) await Bun.sleep(100);
  };
  const manager = () => new PackageManager(root, hooks(), "0.1.0", undefined, undefined, true);
  let first: LocalArchives | undefined, second: LocalArchives | undefined;
  try {
    let changes = 0;
    first = new LocalArchives(manager(), new DiagnosticLog(), () => changes++);
    const a = await archive(dir, "1.0.0", "// one");
    await first.load(a.file, "test/fixture", true, { watch: true });
    expect(first.list()).toEqual([{ id: "fixture", archive: a.file, repo: "test/fixture", watching: true }]);
    const b = await archive(dir, "1.0.0", "// two");
    await waitFor(b.hash);
    await first.settle();
    expect(readRegistry(root).plugins.fixture?.hash).toBe(b.hash);

    first.setWatching("fixture", false);
    await archive(dir, "1.0.0", "// three");
    await Bun.sleep(600);
    await first.settle();
    expect(readRegistry(root).plugins.fixture?.hash).toBe(b.hash);
    expect(changes).toBeGreaterThan(2);
    expect(() => first!.setWatching("missing", true)).toThrow("No local archive");

    // The saved choice comes back when the profile opens again.
    first.setWatching("fixture", true);
    first.closeWatches();
    second = new LocalArchives(manager(), new DiagnosticLog());
    expect(second.list()[0]?.watching).toBe(true);
    second.resume();
    const d = await archive(dir, "1.0.0", "// four");
    await waitFor(d.hash);
    await second.settle();
    expect(readRegistry(root).plugins.fixture?.hash).toBe(d.hash);

    // Removing the plugin elsewhere stops its watch instead of reinstalling it.
    await second.packages.remove("fixture", true);
    expect(second.list()).toEqual([]);
    await archive(dir, "1.0.0", "// five");
    await Bun.sleep(600);
    await second.settle();
    expect(readRegistry(root).plugins.fixture?.removed).toBe(true);
  } finally {
    first?.closeWatches();
    second?.closeWatches();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the controller validates modes and reports failed switches", async () => {
  const { dir } = scratch();
  try {
    const switches: (string | null)[] = [];
    const states: boolean[] = [];
    let fail = true;
    const normal = new DevelopmentController({
      configRoot: dir,
      profile: null,
      archives: null,
      log: new DiagnosticLog(),
      changed: (s) => states.push(s.switching),
      switchMode: async (profile) => {
        switches.push(profile);
        if (fail) throw new Error("Processes can't stop right now: busy");
      },
    });
    expect((await normal.request({ operation: "load", archive: "/x.tar.gz", repo: "a/b", approved: true })).error).toContain("development mode first");
    expect((await normal.request({ operation: "exit" })).error).toContain("normal mode");
    expect((await normal.request({ operation: "enter", profile: "../x" })).error).toContain("Profile names");
    const refused = await normal.request({ operation: "enter", profile: "feat" });
    expect(refused.error).toContain("busy");
    expect(refused.state.switching).toBe(false);
    expect(states).toEqual([true, false]);
    fail = false;
    expect((await normal.request({ operation: "enter", profile: "feat" })).error).toBeUndefined();
    expect(switches).toEqual(["feat", "feat"]);
    expect((await normal.request({ operation: "bogus" as never })).error).toContain("Unknown");

    const active = new DevelopmentController({
      configRoot: dir,
      profile: "feat",
      archives: null,
      log: new DiagnosticLog(),
      changed: () => {},
      switchMode: async (profile) => void switches.push(profile),
    });
    expect(active.state()).toMatchObject({ available: true, active: true, profile: "feat" });
    expect((await active.request({ operation: "enter", profile: "feat" })).error).toContain("Already");
    expect((await active.request({ operation: "exit" })).error).toBeUndefined();
    expect(switches.at(-1)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("typed paths resolve to an existing folder", () => {
  const { dir } = scratch();
  try {
    writeFileSync(join(dir, "a.tar.gz"), "");
    expect(folderOf(join(dir, "a.tar.gz"))).toBe(dir);
    expect(folderOf(`  ${dir}  `)).toBe(dir);
    expect(folderOf("~/a.tar.gz", dir)).toBe(dir);
    expect(folderOf("~", dir)).toBe(dir);
    for (const path of [undefined, "", "relative/a.tar.gz", join(dir, "missing.tar.gz")]) expect(folderOf(path)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnostics stay bounded", () => {
  const log = new DiagnosticLog(5, 100);
  for (let i = 0; i < 20; i++) log.record("x", "y".repeat(500));
  expect(log.entries.length).toBe(5);
  expect(String(log.entries[0]!.detail).length).toBeLessThanOrEqual(101);
});

test("choosing an archive reads its publisher without installing it", async () => {
  const { dir, root } = scratch();
  try {
    const a = await archive(dir);
    const manager = new PackageManager(root, hooks(), "0.1.0", undefined, undefined, true);
    let picked: string | null = a.file;
    const folders: (string | undefined)[] = [];
    const controller = new DevelopmentController({
      configRoot: dir,
      profile: "feat",
      archives: new LocalArchives(manager, new DiagnosticLog()),
      log: new DiagnosticLog(),
      changed: () => {},
      switchMode: async () => {},
      chooseArchive: async (folder) => (folders.push(folder), picked),
    });
    expect((await controller.request({ operation: "choose" })).chosen).toEqual({ archive: a.file, repo: "test/fixture" });
    expect(readRegistry(root).plugins.fixture).toBeUndefined();
    picked = null;
    expect((await controller.request({ operation: "choose" })).chosen).toBeUndefined();
    picked = join(dir, "notes.txt");
    expect((await controller.request({ operation: "choose" })).error).toContain(".tar.gz");
    expect(folders).toEqual([undefined, dir, dir]);
    // A typed path that exists starts the picker in its folder; a missing one falls back.
    mkdirSync(join(dir, "builds"));
    writeFileSync(join(dir, "builds", "x.tar.gz"), "");
    picked = null;
    await controller.request({ operation: "choose", archive: join(dir, "builds", "x.tar.gz") });
    await controller.request({ operation: "choose", archive: join(dir, "builds") });
    await controller.request({ operation: "choose", archive: join(dir, "missing", "x.tar.gz") });
    expect(folders.slice(-3)).toEqual([join(dir, "builds"), join(dir, "builds"), dir]);
    writeFileSync(join(dir, "broken.tar.gz"), "nope");
    picked = join(dir, "broken.tar.gz");
    expect((await controller.request({ operation: "choose" })).chosen).toEqual({ archive: picked, repo: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
