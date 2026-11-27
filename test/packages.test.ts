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
  protocol: 2, agent: { access: "read" },
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
function setup(
  overrides: Partial<RuntimeHooks> = {},
  fault?: (point: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "tb-packages-"));
  const hooks: RuntimeHooks = {
    prepare: async () => {},
    stop: async () => {},
    probe: async () => {},
    activate: async () => {},
    remove: () => {},
    ...overrides,
  };
  return { root, manager: new PackageManager(root, hooks, "0.1.0", fault) };
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
test("secrets are deleted with the plugin's data only, and a failure doesn't stop removal", async () => {
  const a = await archive(),
    deleted: string[] = [];
  const { root, manager } = setup({
    deleteSecrets: async (p) => {
      deleted.push(`${p.id}@${p.repo}`);
      throw new Error("Keychain locked");
    },
  });
  try {
    await manager.install(await manager.stage(a.bytes, a.hash, "test/fixture"), true);
    await manager.remove("fixture");
    expect(deleted).toEqual([]); // removal alone (like disabling) keeps secrets
    await manager.install(await manager.stage(a.bytes, a.hash, "test/fixture"), true);
    await manager.remove("fixture", true);
    expect(deleted).toEqual(["fixture@test/fixture"]);
    expect(existsSync(join(root, "data/fixture"))).toBe(false);
    expect(manager.registry().plugins.fixture?.deleteDataPending).toBe(false);
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
    await manager.restore(
      "fixture",
      (await import("../src/bun/packages")).recoveryChoiceId(
        manager.registry().plugins.fixture!.history![0]!,
      ),
    );
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
    await manager.restore(
      "fixture",
      (await import("../src/bun/packages")).recoveryChoiceId(
        manager.registry().plugins.fixture!.history![0]!,
      ),
    );
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

test("app seed never reinstalls removed or disabled demo across app updates", async () => {
  const { materializeSeed } = await import("../src/bun/seed");
  for (const choice of ["removed", "disabled"]) {
    const { root, manager } = setup(),
      a = await archive(),
      seed = join(root, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "demo.tar.gz"), a.bytes);
    writeFileSync(
      join(seed, "seed.json"),
      JSON.stringify({ repo: "test/fixture", sha256: a.hash }),
    );
    try {
      await materializeSeed(manager, seed);
      if (choice === "removed") await manager.remove("fixture");
      else await manager.enabled("fixture", false);
      await materializeSeed(manager, seed);
      expect(manager.registry().plugins.fixture?.enabled).toBe(false);
      expect(manager.registry().plugins.fixture?.removed ?? false).toBe(
        choice === "removed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
test("native handoff intent is declarative and requires negotiated capability", () => {
  expect(() =>
    parsePackageManifest({ ...manifest(), handoffActions: ["focus-owned"] }),
  ).toThrow("native.handoff");
  expect(
    parsePackageManifest({
      ...manifest(),
      capabilities: { required: ["ui.core", "native.handoff"], optional: [] },
      handoffActions: ["focus-owned"],
    }).handoffActions,
  ).toEqual(["focus-owned"]);
});

test("enabling changed extracted code is rejected before activation", async () => {
  let activations = 0;
  const { root, manager } = setup({
      activate: async () => {
        activations++;
      },
    }),
    a = await archive();
  try {
    const c = await manager.stage(a.bytes, a.hash, "test/fixture");
    await manager.install(c, true);
    await manager.enabled("fixture", false);
    writeFileSync(
      join(c.packageRoot, "index.js"),
      'throw new Error("tampered code executed")',
    );
    const count = activations;
    await expect(manager.enabled("fixture", true)).rejects.toThrow(
      "bytes changed",
    );
    expect(activations).toBe(count);
    expect(manager.registry().plugins.fixture?.enabled).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("malformed JSON journal quarantines without aborting host recovery", async () => {
  const { root, manager } = setup();
  const tx = join(root, "plugins/transactions/broken");
  mkdirSync(tx, { recursive: true });
  writeFileSync(join(tx, "journal.json"), "{");
  try {
    await manager.recover();
    expect(
      existsSync(
        join(root, "plugins/quarantine-transactions/broken/journal.json"),
      ),
    ).toBe(true);
    expect(manager.recoveryWarnings[0]).toContain("quarantined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("remove with data deletion reinitializes unchanged schema on reinstall", async () => {
  const { root, manager } = setup(),
    a = await migrationArchive(
      "1.0.0",
      1,
      'const r=JSON.parse(await Bun.stdin.text());await Bun.write(r.targetDir+"/initialized",r.fromSchema===null?"initial":"wrong-existing-schema");console.log(JSON.stringify({type:"migration-complete"}));',
    );
  try {
    let c = await manager.stage(a.bytes, a.hash, "test/fixture");
    await manager.install(c, true);
    expect(readFileSync(join(root, "data/fixture/initialized"), "utf8")).toBe(
      "initial",
    );
    await manager.remove("fixture", true);
    expect(existsSync(join(root, "data/fixture"))).toBe(false);
    c = await manager.stage(a.bytes, a.hash, "test/fixture");
    await manager.install(c, true);
    expect(readFileSync(join(root, "data/fixture/initialized"), "utf8")).toBe(
      "initial",
    );
    expect(manager.registry().plugins.fixture?.dataInitialized).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
for (const point of [
  "snapshot-synced",
  "candidate-synced",
  "previous-renamed",
  "candidate-promoted",
  "registry-committed",
  "journal-committed",
])
  test(`durability boundary failure at ${point} preserves a recoverable selection`, async () => {
    let fail = false;
    const seen: string[] = [];
    const { root, manager } = setup({}, (p) => {
        seen.push(p);
        if (fail && p === point) throw new Error("injected " + point);
      }),
      a = await archive(),
      b = await archive(manifest("1.1.0"));
    try {
      await manager.install(
        await manager.stage(a.bytes, a.hash, "test/fixture"),
        true,
      );
      writeFileSync(join(root, "data/fixture/state"), "frozen-old-data");
      fail = true;
      const work = manager.install(
        await manager.stage(b.bytes, b.hash, "test/fixture"),
        true,
      );
      if (point === "journal-committed") await work;
      else await expect(work).rejects.toThrow("injected");
      await manager.recover();
      expect(manager.registry().plugins.fixture?.version).toBe(
        point === "journal-committed" ? "1.1.0" : "1.0.0",
      );
      expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe(
        "frozen-old-data",
      );
      expect(seen).toContain(point);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
test("pending verified candidates survive another version install and release on discard/expiry", async () => {
  const { root, manager } = setup(),
    a = await archive(),
    b = await archive(manifest("1.1.0"));
  try {
    const first = await manager.stage(a.bytes, a.hash, "test/fixture"),
      second = await manager.stage(b.bytes, b.hash, "test/fixture");
    await manager.install(first, true);
    expect(existsSync(second.packageRoot)).toBe(true);
    await manager.install(second, true);
    expect(manager.registry().plugins.fixture?.version).toBe("1.1.0");
    const third = await archive(manifest("1.2.0")),
      candidate = await manager.stage(third.bytes, third.hash, "test/fixture");
    manager.releaseCandidate(candidate);
    manager.collectCandidates();
    expect(existsSync(candidate.packageRoot)).toBe(false);
    const fourth = await archive(manifest("1.3.0")),
      expired = await manager.stage(fourth.bytes, fourth.hash, "test/fixture");
    const pin = join(root, "plugins/candidates", `${expired.lease}.json`);
    const value = JSON.parse(readFileSync(pin, "utf8"));
    value.expires = Date.now() - 1;
    writeFileSync(pin, JSON.stringify(value));
    manager.collectCandidates();
    expect(existsSync(expired.packageRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("recovery of interrupted reinstall after delete-data does not require an old snapshot", async () => {
  const { root, manager } = setup(),
    a = await archive();
  try {
    await manager.install(
      await manager.stage(a.bytes, a.hash, "test/fixture"),
      true,
    );
    await manager.remove("fixture", true);
    const old = manager.registry().plugins.fixture!,
      tx = "reinitialize",
      txDir = join(root, "plugins/transactions", tx),
      data = join(root, "data/fixture");
    mkdirSync(txDir, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "partial"), "new-uncommitted");
    writeFileSync(
      join(txDir, "journal.json"),
      JSON.stringify({
        id: "fixture",
        old,
        next: { ...old, enabled: true, removed: false },
        data,
        backup: join(root, "backups/fixture", tx),
        staged: join(txDir, "data"),
        previous: join(txDir, "previous"),
        phase: "promoting",
        hadData: false,
      }),
    );
    await manager.recover();
    expect(existsSync(data)).toBe(false);
    expect(manager.registry().plugins.fixture?.removed).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installing a stable release preserves a prerelease update preference and records release identity", async () => {
  const a = await archive(), b = await archive(manifest("2.0.0"));
  const {root,manager}=setup();
  try {
    const first=await manager.stage(a.bytes,a.hash,"test/fixture");
    await manager.install({...first,channel:"stable",release:"v1.0.0",requestedRelease:"v1.0.0"},true);
    const registry=manager.registry();
    registry.plugins.fixture!.channel="prerelease";
    writeFileSync(join(root,"plugins/registry.json"),JSON.stringify(registry));
    const second=await manager.stage(b.bytes,b.hash,"test/fixture");
    await manager.install({...second,channel:"stable"},true);
    const installed=manager.registry().plugins.fixture!;
    expect(installed.version).toBe("2.0.0");
    expect(installed.installedChannel).toBe("stable");
    expect(installed.channel).toBe("prerelease");
    expect(installed.requestedRelease).toBeUndefined();
    expect(installed.history?.[0]?.installed.requestedRelease).toBe("v1.0.0");
    expect(installed.history?.[0]?.installed.installedChannel).toBe("stable");
  } finally {
    rmSync(root,{recursive:true,force:true});
    rmSync(a.source,{recursive:true,force:true});
    rmSync(b.source,{recursive:true,force:true});
  }
});

test("malformed persisted release identity is set aside before package use",async () => {
  const a=await archive(),{root,manager}=setup();
  try {
    await manager.install({...await manager.stage(a.bytes,a.hash,"test/fixture"),channel:"stable"},true);
    const valid=manager.registry();
    for (const field of ["installedChannel","availableChannel","availableCommit"]) {
      const corrupt=structuredClone(valid);
      (corrupt.plugins.fixture as unknown as Record<string,unknown>)[field]="unrecognized";
      writeFileSync(join(root,"plugins/registry.json"),JSON.stringify(corrupt));
      expect(manager.registry().plugins.fixture).toBeUndefined();
      expect(manager.registry().invalid?.fixture?.error).toBeTruthy();
    }
    writeFileSync(join(root,"plugins/registry.json"),JSON.stringify(valid));
    expect(manager.registry().plugins.fixture!.installedChannel).toBe("stable");
  } finally {rmSync(root,{recursive:true,force:true});rmSync(a.source,{recursive:true,force:true});}
});

test("one unusable installation record never stops the others, and is kept as it was", async () => {
  const a = await archive(),
    b = await archive(manifest("1.0.0", "other")),
    { root, manager } = setup();
  try {
    await manager.install(await manager.stage(a.bytes, a.hash, "test/fixture"), true);
    await manager.install(await manager.stage(b.bytes, b.hash, "test/fixture"), true);
    const file = join(root, "plugins/registry.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.plugins.other.hash = "not a hash";
    writeFileSync(file, JSON.stringify(saved));
    const registry = manager.registry();
    expect(Object.keys(registry.plugins)).toEqual(["fixture"]);
    expect(registry.invalid?.other?.error).toContain("identity/path");
    // Saving keeps the unusable record, under `invalid`, untouched.
    await manager.enabled("fixture", false);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.invalid.other.record).toEqual(saved.plugins.other);
    expect(after.plugins.other).toBeUndefined();
    // A valid record for the same plugin replaces it.
    await manager.install(await manager.stage(b.bytes, b.hash, "test/fixture"), true);
    expect(manager.registry().plugins.other?.version).toBe("1.0.0");
    expect(manager.registry().invalid).toBeUndefined();
  } finally {
    for (const dir of [root, a.source, b.source]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugin list ToolBelt can't read reads as empty and is never overwritten", async () => {
  const a = await archive(),
    { root, manager } = setup();
  try {
    mkdirSync(join(root, "plugins"), { recursive: true });
    writeFileSync(join(root, "plugins/registry.json"), "{ damaged");
    expect(manager.registry().plugins).toEqual({});
    expect(manager.unreadable).toContain("couldn't read its plugin list");
    await expect(manager.install(await manager.stage(a.bytes, a.hash, "test/fixture"), true)).rejects.toThrow();
    expect(readFileSync(join(root, "plugins/registry.json"), "utf8")).toBe("{ damaged");
    rmSync(join(root, "plugins/registry.json"));
    expect(manager.registry().plugins).toEqual({});
    expect(manager.unreadable).toBeUndefined();
  } finally {
    for (const dir of [root, a.source]) rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugin built for another protocol stays installed and is refused only when installing or starting", async () => {
  const a = await archive(),
    old = await archive({ ...manifest("0.9.0"), protocol: 1, agent: undefined } as unknown as ReturnType<typeof manifest>),
    { root, manager } = setup();
  try {
    await expect(manager.stage(old.bytes, old.hash, "test/fixture")).rejects.toThrow("Plugin needs an update: it was built for plugin protocol 1");
    // An installation from the previous ToolBelt: its record names protocol 1.
    await manager.install(await manager.stage(a.bytes, a.hash, "test/fixture"), true);
    const file = join(root, "plugins/registry.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.plugins.fixture.manifest = { ...saved.plugins.fixture.manifest, protocol: 1, agent: undefined };
    writeFileSync(file, JSON.stringify(saved));
    expect(manager.registry().plugins.fixture?.manifest.protocol).toBe(1);
    expect(manager.registry().invalid).toBeUndefined();
  } finally {
    for (const dir of [root, a.source, old.source]) rmSync(dir, { recursive: true, force: true });
  }
});
test("a floating package requires the ui.floating capability and may have no screens", () => {
  const floating = { ...manifest(), screens: [], floating: { shortcut: "k" } };
  expect(() => parsePackageManifest(floating)).toThrow("ui.floating");
  expect(parsePackageManifest({ ...floating, capabilities: { required: ["ui.core", "ui.floating"], optional: [] } }).floating).toEqual({ shortcut: "k" });
  expect(() => parsePackageManifest({ ...manifest(), screens: [] })).toThrow("at least one screen");
});
