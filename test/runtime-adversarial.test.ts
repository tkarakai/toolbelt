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
    name: "render of an undeclared surface",
    script:
      'console.log(JSON.stringify({type:"hello",protocol:2,sdk:"test",capabilities:[]}));console.log(JSON.stringify({type:"ready"}));console.log(JSON.stringify({type:"render",surface:"screen:nope",tree:{type:"text",text:"x"}}));setInterval(()=>{},1000)',
  },
  {
    name: "unterminated frame",
    script: `process.stdout.write('x'.repeat(${LIMITS.messageBytes + 1}));setInterval(()=>{},1000)`,
  },
  {
    name: "message flood",
    script:
      'console.log(JSON.stringify({type:"hello",protocol:2,sdk:"test",capabilities:[]}));console.log(JSON.stringify({type:"ready"}));for(let i=0;i<200;i++)console.log(JSON.stringify({type:"badge",value:i}));setInterval(()=>{},1000)',
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
        protocol: 2, agent: { access: "read" },
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

test("an invalid screen costs only that screen: the plugin keeps running and recovers with a valid render", async () => {
  const root = mkdtempSync(join(tmpdir(), "tb-protocol-"));
  writeFileSync(
    join(root, "toolbelt.json"),
    JSON.stringify({
      id: "partial",
      name: "Partial",
      entry: "index.js",
      protocol: 2, agent: { access: "read" },
      screens: [{ id: "main", title: "Main" }, { id: "activity", title: "Activity" }],
    }),
  );
  // Activity first sends a tree over the complexity limit, then one with an invalid cell, then a
  // valid one; Main is valid throughout. "go" on stdin sends the valid Activity tree.
  writeFileSync(
    join(root, "index.js"),
    `const send = (m) => console.log(JSON.stringify(m));
send({ type: "hello", protocol: 2, sdk: "test", capabilities: [] });
send({ type: "ready" });
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: "r" + i, cells: { a: "x", b: "y", c: "z" } }));
const table = (r, cells) => ({ type: "table", id: "runs", columns: [{ key: "a", title: "A" }], rows: cells ? [{ id: "a", cells }] : r });
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\\n").filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.type === "open" && m.surface === "screen:main") send({ type: "render", surface: "screen:main", instance: "person", tree: { type: "text", text: "main is fine" } });
    if (m.type === "open" && m.surface === "screen:activity") {
      send({ type: "render", surface: "screen:activity", instance: "person", tree: table(rows(15000)) });
      send({ type: "render", surface: "screen:activity", instance: "person", tree: table(null, { a: { text: {} } }) });
    }
    if (m.type === "event" && m.name === "go") send({ type: "render", surface: "screen:activity", instance: "person", tree: { type: "text", text: "activity is back" } });
  }
});
setInterval(() => {}, 1000);`,
  );
  const trees: { surface: string; tree: any }[] = [];
  const host = new PluginHost({ dirs: [root], bun: process.execPath, data: join(root, "data"), host: { name: "test", version: "0.1.0" } });
  host.subscribe({ plugins: () => {}, tree: (_p, surface, tree) => trees.push({ surface, tree }), toast: () => {} });
  try {
    host.start();
    await until(() => host.list()[0]?.state === "running");
    host.open("partial", "screen:main");
    host.open("partial", "screen:activity");
    await until(() => trees.some((t) => t.surface === "screen:main") && trees.filter((t) => t.surface === "screen:activity").length >= 2);
    expect(host.list()[0]).toMatchObject({ state: "running" });
    // Each rejection shows the host's error in place of the screen, saying why.
    const shown = trees.filter((t) => t.surface === "screen:activity");
    expect(shown.map((t) => t.tree.title)).toEqual(["This screen couldn't be shown", "This screen couldn't be shown"]);
    expect(shown[0].tree.description).toContain("Protocol complexity limit: more than 50000 values");
    expect(shown[1].tree.description).toContain("message.tree.rows[0].cells.a");
    // The snapshot reports the latest reason and no tree, so readers (agents) don't take the error for content.
    expect(host.snapshot("partial", "screen:activity")).toMatchObject({ tree: null, error: "Invalid protocol value at message.tree.rows[0].cells.a" });
    expect(host.snapshot("partial", "screen:main")?.tree).toEqual({ type: "text", text: "main is fine" });
    host.event("partial", "screen:activity", "go");
    await until(() => host.snapshot("partial", "screen:activity")?.tree !== null);
    expect(host.snapshot("partial", "screen:activity")).toEqual({ tree: { type: "text", text: "activity is back" }, at: expect.any(Number), viewers: 1 });
    expect(host.list()[0].state).toBe("running");
  } finally {
    await host.stopPlugin("partial");
    rmSync(root, { recursive: true, force: true });
  }
});
