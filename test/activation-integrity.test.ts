import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../src/bun/host";
import { PackageManager } from "../src/bun/packages";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tb-activation-")),
    source = join(root, "source");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(source);
  writeFileSync(
    join(source, "toolbelt.json"),
    JSON.stringify({
      formatVersion: 1,
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      repo: "test/fixture",
      entry: "index.js",
      protocol: 1,
      screens: [{ id: "main", title: "Main" }],
      requires: { host: ">=0.1.0", bun: ">=1.3.0", platforms: ["portable"] },
      capabilities: { required: ["ui.core"], optional: [] },
      data: { schema: 1 },
    }),
  );
  writeFileSync(
    join(source, "index.js"),
    `const send=m=>console.log(JSON.stringify(m));send({type:'hello',protocol:1,sdk:'fixture',capabilities:['ui.core']});send({type:'ready'});let buf='';for await(const c of Bun.stdin.stream()){buf+=new TextDecoder().decode(c);let n;while((n=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(m.type==='prepare')send({type:'prepared',requestId:m.requestId,ready:true});if(m.type==='event'&&m.name==='boom')process.exit(1);}}`.replaceAll(
      "'\\\\n'",
      "'\\n'",
    ),
  );
  const archive = join(root, "package.tar.gz");
  const p = Bun.spawn([
    "tar",
    "--format",
    "ustar",
    "-czf",
    archive,
    "-C",
    source,
    "toolbelt.json",
    "index.js",
  ]);
  if (await p.exited) throw new Error("tar");
  const host = new PluginHost({
    dirs: [],
    registryRoot: root,
    bun: process.execPath,
    host: { name: "fixture", version: "0.1.0" },
    data: join(root, "data"),
  });
  const manager = new PackageManager(root, {
    prepare: (id, r) => host.prepare(id, r),
    stop: (id) => host.stopPlugin(id),
    probe: (c, d) => host.probe(c, d),
    activate: (p) => host.activate(p),
    remove: (id) => host.remove(id),
  });
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer()),
    hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    candidate = await manager.stage(bytes, hash, "test/fixture");
  await manager.install(candidate, true);
  return { root, host, manager, candidate };
}
for (const operation of ["enable", "restart"])
  test(`actual child ${operation} rejects tampered bytes before execution`, async () => {
    const f = await fixture();
    const marker = join(f.root, "tampered-executed");
    try {
      if (operation === "enable") await f.manager.enabled("fixture", false);
      writeFileSync(
        join(f.candidate.packageRoot, "index.js"),
        `await Bun.write(${JSON.stringify(marker)},'unsafe');setInterval(()=>{},1000);`,
      );
      await expect(
        operation === "enable"
          ? f.manager.enabled("fixture", true)
          : f.host.restart("fixture"),
      ).rejects.toThrow("bytes changed");
      expect(existsSync(marker)).toBe(false);
      if (operation === "restart")
        expect(f.host.list()[0]?.state).toBe("crashed");
    } finally {
      await f.host.stopPlugin("fixture");
      rmSync(f.root, { recursive: true, force: true });
    }
  });
