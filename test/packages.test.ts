import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PackageManager,
  readRegistry,
  type RuntimeHooks,
  extractArchive,
} from "../src/bun/packages";
import { parsePackageManifest } from "../src/shared/package";
const manifest = (version = "1.0.0", id = "fixture") => ({
  formatVersion: 1,
  id,
  name: "Fixture",
  version,
  repo: "test/fixture",
  entry: "index.js",
  protocol: 1,
  icon: "box",
  screens: [{ id: "main", title: "Main" }],
  requires: { host: ">=0.1.0", bun: ">=1.3.0", platforms: ["portable"] },
  capabilities: { required: ["ui.core"], optional: [] },
  data: { schema: 1 },
});
async function archive(m = manifest()) {
  const source = mkdtempSync(join(tmpdir(), "tb-package-source-"));
  writeFileSync(join(source, "toolbelt.json"), JSON.stringify(m));
  writeFileSync(join(source, "index.js"), "");
  const file = join(source, "package.tgz");
  const p = Bun.spawn([
    "tar",
    "--format",
    "ustar",
    "-czf",
    file,
    "-C",
    source,
    "toolbelt.json",
    "index.js",
  ]);
  expect(await p.exited).toBe(0);
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { bytes, hash, source };
}
function setup(overrides: Partial<RuntimeHooks> = {}) {
  const root = mkdtempSync(join(tmpdir(), "tb-packages-"));
  const hooks: RuntimeHooks = {
    prepare: async () => {},
    stop: async () => {},
    probe: async () => {},
    activate: async () => {},
    remove: () => {},
    ...overrides,
  };
  return { root, manager: new PackageManager(root, hooks) };
}
test("verified archive installs then disables and retains data on removal", async () => {
  const a = await archive(),
    { root, manager } = setup();
  try {
    const c = await manager.stage(a.bytes, a.hash, "test/fixture");
    await manager.install(c, true);
    expect(manager.registry().plugins.fixture?.version).toBe("1.0.0");
    writeFileSync(join(root, "data/fixture", "state"), "kept");
    await manager.enabled("fixture", false);
    await manager.remove("fixture");
    expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe("kept");
    expect(manager.registry().plugins.fixture?.removed).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(a.source, { recursive: true, force: true });
  }
});
test("failed candidate probe preserves old package and exact data", async () => {
  let fail = false;
  const { root, manager } = setup({
    probe: async () => {
      if (fail) throw new Error("probe failure");
    },
  });
  const a = await archive(),
    b = await archive(manifest("1.1.0"));
  try {
    await manager.install(
      await manager.stage(a.bytes, a.hash, "test/fixture"),
      true,
    );
    writeFileSync(join(root, "data/fixture/state"), "original");
    fail = true;
    await expect(
      manager.install(
        await manager.stage(b.bytes, b.hash, "test/fixture"),
        true,
      ),
    ).rejects.toThrow("probe failure");
    expect(readRegistry(root).plugins.fixture?.version).toBe("1.0.0");
    expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe(
      "original",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("failed stop before snapshot cannot delete existing data", async () => {
  const { root, manager } = setup({
    stop: async () => {
      throw new Error("stop failed");
    },
  });
  const a = await archive();
  mkdirSync(join(root, "data/fixture"), { recursive: true });
  writeFileSync(join(root, "data/fixture/state"), "original");
  await expect(
    manager.install(await manager.stage(a.bytes, a.hash, "test/fixture"), true),
  ).rejects.toThrow();
  expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe(
    "original",
  );
});
test("wrong hashes and incompatible capabilities never activate", async () => {
  const { root, manager } = setup();
  const a = await archive();
  await expect(
    manager.stage(a.bytes, "0".repeat(64), "test/fixture"),
  ).rejects.toThrow("checksum");
  expect(existsSync(join(root, "plugins/registry.json"))).toBe(false);
});
test("unsafe versions and entries reject before package path construction", () => {
  expect(() =>
    parsePackageManifest({ ...manifest(), version: "../../escape" }),
  ).toThrow();
  expect(() =>
    parsePackageManifest({ ...manifest(), entry: "../escape" }),
  ).toThrow();
  expect(() =>
    parsePackageManifest({ ...manifest(), assets: { x: "/etc/passwd" } }),
  ).toThrow();
});
test("truncated/non gzip archive rejected", () => {
  expect(() =>
    extractArchive(
      new Uint8Array([1, 2, 3]),
      mkdtempSync(join(tmpdir(), "tb-bad-")),
    ),
  ).toThrow();
});

test("prepare refusal never stops the existing plugin", async () => {
  let refuse = false,
    stops = 0;
  const { root, manager } = setup({
    prepare: async () => {
      if (refuse) throw new Error("busy operation");
    },
    stop: async () => {
      stops++;
    },
  });
  const a = await archive();
  try {
    const c = await manager.stage(a.bytes, a.hash, "test/fixture");
    await manager.install(c, true);
    const before = stops;
    refuse = true;
    await expect(manager.install(c, true)).rejects.toThrow("busy");
    expect(stops).toBe(before);
    expect(manager.registry().plugins.fixture?.version).toBe("1.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("final activation failure atomically restores old data and selection", async () => {
  let failure = false;
  const { root, manager } = setup({
    activate: async (p) => {
      if (failure && p.version === "1.1.0")
        throw new Error("final ready failed");
    },
  });
  const a = await archive(),
    b = await archive(manifest("1.1.0"));
  try {
    await manager.install(
      await manager.stage(a.bytes, a.hash, "test/fixture"),
      true,
    );
    writeFileSync(join(root, "data/fixture/state"), "before");
    failure = true;
    await expect(
      manager.install(
        await manager.stage(b.bytes, b.hash, "test/fixture"),
        true,
      ),
    ).rejects.toThrow("final ready failed");
    expect(manager.registry().plugins.fixture?.version).toBe("1.0.0");
    expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe(
      "before",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("concurrent different-id installs preserve both registry entries", async () => {
  const { root, manager } = setup({
    probe: async () => {
      await Bun.sleep(10);
    },
  });
  const a = await archive(manifest("1.0.0", "one")),
    b = await archive(manifest("1.0.0", "two"));
  try {
    await Promise.all([
      manager.install(
        await manager.stage(a.bytes, a.hash, "test/fixture"),
        true,
      ),
      manager.install(
        await manager.stage(b.bytes, b.hash, "test/fixture"),
        true,
      ),
    ]);
    expect(Object.keys(manager.registry().plugins).sort()).toEqual([
      "one",
      "two",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("changed approved extracted bytes fail before lifecycle execution", async () => {
  let calls = 0;
  const { root, manager } = setup({
    prepare: async () => {
      calls++;
    },
  });
  const a = await archive();
  try {
    const c = await manager.stage(a.bytes, a.hash, "test/fixture");
    writeFileSync(join(c.packageRoot, "index.js"), "changed");
    await expect(manager.install(c, true)).rejects.toThrow("bytes changed");
    expect(calls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("unsupported capabilities and Bun requirements reject during staging", async () => {
  const { root, manager } = setup();
  const m = manifest();
  m.capabilities.required = ["unknown.future"];
  const a = await archive(m);
  try {
    await expect(
      manager.stage(a.bytes, a.hash, "test/fixture"),
    ).rejects.toThrow("capabilities");
    const b = await archive({
      ...manifest(),
      requires: { ...manifest().requires, bun: ">=999.0.0" },
    });
    await expect(
      manager.stage(b.bytes, b.hash, "test/fixture"),
    ).rejects.toThrow("Bun");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("successful upgrade retains a bounded matching recovery snapshot", async () => {
  const { root, manager } = setup();
  try {
    for (let n = 0; n < 5; n++) {
      const a = await archive(manifest(`1.${n}.0`));
      await manager.install(
        await manager.stage(a.bytes, a.hash, "test/fixture"),
        true,
      );
      writeFileSync(join(root, "data/fixture/state"), String(n));
    }
    expect(manager.registry().plugins.fixture?.history?.length).toBe(3);
    await manager.restore("fixture", "0");
    expect(manager.registry().plugins.fixture?.version).toBe("1.1.0");
    expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe("4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function migrationArchive(
  version: string,
  schema: number,
  script: string,
) {
  const source = mkdtempSync(join(tmpdir(), "tb-migration-source-"));
  const m = {
    ...manifest(version),
    data: { schema },
    migration: { entry: "migrate.js" },
  };
  writeFileSync(join(source, "toolbelt.json"), JSON.stringify(m));
  writeFileSync(join(source, "index.js"), "");
  writeFileSync(join(source, "migrate.js"), script);
  const file = join(source, "package.tgz");
  const p = Bun.spawn([
    "tar",
    "--format",
    "ustar",
    "-czf",
    file,
    "-C",
    source,
    "toolbelt.json",
    "index.js",
    "migrate.js",
  ]);
  expect(await p.exited).toBe(0);
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  return {
    bytes,
    hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    source,
  };
}
test("migration failure restores old data and running version", async () => {
  const { root, manager } = setup();
  const a = await archive(),
    b = await migrationArchive(
      "1.1.0",
      2,
      'console.log(JSON.stringify({type:"migration-failed",error:"fixture failure"}))',
    );
  try {
    await manager.install(
      await manager.stage(a.bytes, a.hash, "test/fixture"),
      true,
    );
    writeFileSync(join(root, "data/fixture/state"), "old");
    await expect(
      manager.install(
        await manager.stage(b.bytes, b.hash, "test/fixture"),
        true,
      ),
    ).rejects.toThrow("Migration failed");
    expect(manager.registry().plugins.fixture?.version).toBe("1.0.0");
    expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe("old");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("invalid journal paths are quarantined without touching outside data", async () => {
  const { root, manager } = setup(),
    outside = mkdtempSync(join(tmpdir(), "tb-outside-")),
    tx = join(root, "plugins/transactions", "fixture");
  mkdirSync(tx, { recursive: true });
  writeFileSync(join(outside, "state"), "safe");
  writeFileSync(
    join(tx, "journal.json"),
    JSON.stringify({
      id: "fixture",
      phase: "promoting",
      data: outside,
      previous: join(tx, "previous"),
    }),
  );
  try {
    await manager.recover();
    expect(readFileSync(join(outside, "state"), "utf8")).toBe("safe");
    expect(
      existsSync(join(root, "plugins/quarantine-transactions/fixture")),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test("removal deletes unleased code but preserves code held by live helper lease", async () => {
  const { root, manager } = setup(),
    a = await archive();
  try {
    const c = await manager.stage(a.bytes, a.hash, "test/fixture");
    await manager.install(c, true);
    const dir = join(root, "plugins/leases/fixture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, packageRoot: c.packageRoot }),
    );
    await manager.remove("fixture");
    expect(existsSync(c.packageRoot)).toBe(true);
    rmSync(dir, { recursive: true });
    manager.collectPackages("fixture");
    expect(existsSync(c.packageRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema-incompatible downgrade restores its matching snapshot", async () => {
  const { root, manager } = setup(),
    a = await archive(),
    b = await migrationArchive(
      "2.0.0",
      2,
      'console.log(JSON.stringify({type:"migration-complete"}))',
    );
  try {
    await manager.install(
      await manager.stage(a.bytes, a.hash, "test/fixture"),
      true,
    );
    writeFileSync(join(root, "data/fixture/state"), "schema-one");
    await manager.install(
      await manager.stage(b.bytes, b.hash, "test/fixture"),
      true,
    );
    writeFileSync(join(root, "data/fixture/state"), "schema-two");
    await manager.restore("fixture", "0");
    expect(manager.registry().plugins.fixture?.dataSchema).toBe(1);
    expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe(
      "schema-one",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("migration timeout restores old state and terminates disposable migrator", async () => {
  const { LIMITS } = await import("../src/shared/package");
  const timeout = LIMITS.migrationMs,
    { root, manager } = setup(),
    a = await archive(),
    b = await migrationArchive("2.0.0", 2, "setInterval(()=>{},1000)");
  try {
    await manager.install(
      await manager.stage(a.bytes, a.hash, "test/fixture"),
      true,
    );
    writeFileSync(join(root, "data/fixture/state"), "old");
    LIMITS.migrationMs = 50;
    await expect(
      manager.install(
        await manager.stage(b.bytes, b.hash, "test/fixture"),
        true,
      ),
    ).rejects.toThrow("timed out");
    expect(manager.registry().plugins.fixture?.version).toBe("1.0.0");
    expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe("old");
  } finally {
    LIMITS.migrationMs = timeout;
    rmSync(root, { recursive: true, force: true });
  }
});
for (const phase of ["prepared", "promoting", "committed"])
  test(`interrupted ${phase} transaction recovers deterministically`, async () => {
    const { root, manager } = setup(),
      a = await archive();
    try {
      const c = await manager.stage(a.bytes, a.hash, "test/fixture");
      await manager.install(c, true);
      const old = manager.registry().plugins.fixture!,
        id = "fixture",
        tx = "interruption",
        txDir = join(root, "plugins/transactions", tx),
        data = join(root, "data", id),
        backup = join(root, "backups", id, tx),
        staged = join(txDir, "data"),
        previous = join(txDir, "previous");
      mkdirSync(txDir, { recursive: true });
      writeFileSync(join(data, "state"), "old");
      if (phase !== "prepared") {
        const { renameSync } = await import("node:fs");
        renameSync(data, previous);
        mkdirSync(data);
        writeFileSync(join(data, "state"), "candidate");
      }
      writeFileSync(
        join(txDir, "journal.json"),
        JSON.stringify({
          id,
          old,
          next: old,
          data,
          backup,
          staged,
          previous,
          phase,
        }),
      );
      await manager.recover();
      expect(readFileSync(join(data, "state"), "utf8")).toBe(
        phase === "committed" ? "candidate" : "old",
      );
      expect(existsSync(txDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
