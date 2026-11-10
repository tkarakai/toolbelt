import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../src/bun/host";
import { LIMITS } from "../src/shared/package";
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(10);
  }
}
for (const scenario of [
  {
    name: "render before ready",
    script:
      'console.log(JSON.stringify({type:"render",surface:"screen:main",tree:{type:"text",text:"bad"}}));setInterval(()=>{},1000)',
  },
  {
    name: "React crashing cell",
    script:
      'console.log(JSON.stringify({type:"hello",protocol:1,sdk:"test",capabilities:[]}));console.log(JSON.stringify({type:"ready"}));console.log(JSON.stringify({type:"render",surface:"screen:main",tree:{type:"table",id:"a",columns:[],rows:[{id:"a",cells:{x:{text:{}}}}]}}));setInterval(()=>{},1000)',
  },
  {
    name: "unterminated frame",
    script: `process.stdout.write('x'.repeat(${LIMITS.messageBytes + 1}));setInterval(()=>{},1000)`,
  },
  {
    name: "message flood",
    script:
      'for(let i=0;i<200;i++)console.log(JSON.stringify({type:"hello",protocol:1,sdk:"test",capabilities:[]}));setInterval(()=>{},1000)',
  },
])
  test(`malformed plugin quarantines: ${scenario.name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tb-protocol-"));
    writeFileSync(
      join(root, "toolbelt.json"),
      JSON.stringify({
        id: "malformed",
        name: "Malformed",
        entry: "index.js",
        protocol: 1,
        screens: [{ id: "main", title: "Main" }],
      }),
    );
    writeFileSync(join(root, "index.js"), scenario.script);
    const trees: unknown[] = [];
    const host = new PluginHost({
      dirs: [root],
      bun: process.execPath,
      data: join(root, "data"),
      host: { name: "test", version: "0.1.0" },
    });
    host.subscribe({
      plugins: () => {},
      tree: (_p, _s, t) => trees.push(t),
      toast: () => {},
    });
    try {
      host.start();
      await until(() => host.list()[0]?.state === "crashed");
      expect(trees).toEqual([]);
      expect(host.list()[0]?.error).toBeTruthy();
    } finally {
      await host.stopPlugin("malformed");
      rmSync(root, { recursive: true, force: true });
    }
  });
