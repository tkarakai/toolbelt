import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PackageManager, type RuntimeHooks } from "../src/bun/packages";
const hooks: RuntimeHooks = {
  prepare: async () => {},
  stop: async () => {},
  probe: async () => {},
  activate: async () => {},
  remove: () => {},
};
async function archive(root: string, version: string) {
  const source = join(root, `source-${version}`);
  mkdirSync(source);
  writeFileSync(
    join(source, "toolbelt.json"),
    JSON.stringify({
      formatVersion: 1,
      id: "fixture",
      name: "Fixture",
      version,
      repo: "test/fixture",
      entry: "index.js",
      protocol: 1,
      screens: [{ id: "main", title: "Main" }],
      requires: { host: ">=0.1.0", bun: ">=1.3.0", platforms: ["portable"] },
      capabilities: { required: ["ui.core"], optional: [] },
      data: { schema: 1 },
    }),
  );
  writeFileSync(join(source, "index.js"), "export {};");
  const file = join(root, `${version}.tar.gz`);
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
  if (await p.exited) throw new Error("archive");
  return file;
}
for (const point of [
  "previous-renamed",
  "candidate-promoted",
  "registry-committed",
  "journal-committed",
])
  test(`SIGKILL during ${point} recovers in a fresh manager without catch/finally`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tb-power-cut-"));
    try {
      const manager = new PackageManager(root, hooks),
        old = await archive(root, "1.0.0"),
        next = await archive(root, "1.1.0");
      const bytes = new Uint8Array(await Bun.file(old).arrayBuffer()),
        hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      await manager.install(
        await manager.stage(bytes, hash, "test/fixture"),
        true,
      );
      writeFileSync(join(root, "data/fixture/state"), "old-data");
      const code = `import{PackageManager}from${JSON.stringify(join(import.meta.dir, "../src/bun/packages.ts"))};const root=${JSON.stringify(root)};const hooks={prepare:async()=>{},stop:async()=>{},probe:async(_c,data)=>{await Bun.write(data+'/state','candidate-data')},activate:async()=>{},remove:()=>{}};const manager=new PackageManager(root,hooks,'0.1.0',point=>{if(point===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL')});const bytes=new Uint8Array(await Bun.file(${JSON.stringify(next)}).arrayBuffer()),hash=new Bun.CryptoHasher('sha256').update(bytes).digest('hex');await manager.install(await manager.stage(bytes,hash,'test/fixture'),true);`;
      const child = Bun.spawn([process.execPath, "-e", code], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const status = await child.exited;
      expect(status).not.toBe(0);
      expect(child.signalCode).toBe("SIGKILL");
      const recovered = new PackageManager(root, hooks);
      await recovered.recover();
      expect(recovered.registry().plugins.fixture?.version).toBe(
        point === "journal-committed" ? "1.1.0" : "1.0.0",
      );
      expect(readFileSync(join(root, "data/fixture/state"), "utf8")).toBe(
        point === "journal-committed" ? "candidate-data" : "old-data",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
