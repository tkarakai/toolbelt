// The plugin host against real child processes (fixtures in test/fixtures).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, discover, pluginDirs } from "../src/bun/host";
import type { Node } from "../src/shared/protocol";
import type { PluginInfo } from "../src/shared/plugin-state";
import { SDK_VERSION } from "../src/shared/package";

const fixtures = join(import.meta.dir, "fixtures");
/** The echo fixture's counter text. */
const count = (tree: Node | null | undefined) => JSON.stringify(tree ?? null).match(/count \d+/)?.[0];
const data = mkdtempSync(join(tmpdir(), "toolbelt-host-"));

/** Resolve when `check` passes, polling. */
async function until<T>(
  check: () => T | undefined | false,
  ms = 5000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
}

describe("discover", () => {
  test("finds valid plugins, skips broken manifests, first id wins", () => {
    const skipped: string[] = [];
    const found = discover(
      [join(fixtures, "echo"), fixtures, "/nonexistent"],
      (m) => skipped.push(m),
    );
    expect(found.map((d) => d.manifest.id).sort()).toEqual(["crash", "echo", "floater"]);
    expect(found.find((d) => d.manifest.id === "echo")!.dir).toBe(
      join(fixtures, "echo"),
    );
    expect(skipped.some((s) => s.includes("bad"))).toBe(true);
  });

  test("plugin directories: extra, then installed, then bundled", () => {
    expect(
      pluginDirs({ bundled: "/app/plugins", home: "/Users/x", extra: "/a:/b" }),
    ).toEqual([
      "/a",
      "/b",
      "/Users/x/Library/Application Support/Toolbelt/plugins",
      "/app/plugins",
    ]);
  });
});

describe("PluginHost", () => {
  let host: PluginHost | undefined;
  afterEach(() => host?.stop());

  function start() {
    const trees: { plugin: string; surface: string; tree: Node }[] = [];
    const toasts: string[] = [];
    const navigations: string[] = [];
    let plugins: PluginInfo[] = [];
    host = new PluginHost({
      dirs: [join(fixtures, "echo"), join(fixtures, "crash")],
      bun: process.execPath,
      host: { name: "test", version: "0" },
      data,
    });
    host.subscribe({
      plugins: (l) => (plugins = l),
      tree: (plugin, surface, tree) => trees.push({ plugin, surface, tree }),
      toast: (_p, t) => toasts.push(t),
      navigate: (p, screen, select) => navigations.push(`${p}/${screen}/${select}`),
    });
    host.start();
    return { trees, toasts, navigations, plugins: () => plugins };
  }

  test("opens a surface, relays events, badges and toasts", async () => {
    const s = start();
    expect(host!.open("echo", "screen:main")).toBeNull();
    await until(() => s.trees.find((t) => t.surface === "screen:main"));
    expect(count(s.trees.at(-1)!.tree)).toBe("count 0");

    host!.event("echo", "screen:main", "bump");
    await until(() =>
      s.trees.some((t) => JSON.stringify(t.tree).includes("count 1")),
    );
    await until(() => s.toasts.includes("now 1"));
    await until(
      () => s.plugins().find((p) => p.manifest.id === "echo")?.badge === 1,
    );

    // The handshake's SDK version is kept for Settings → Plugins.
    expect(s.plugins().find((p) => p.manifest.id === "echo")?.sdk).toBe(SDK_VERSION);

    // A second viewer gets the cached tree right away.
    expect(count(host!.open("echo", "screen:main"))).toBe("count 1");
  });

  test("a floating plugin renders its floating surface and gets the agent command", async () => {
    const trees: { plugin: string; surface: string; tree: Node }[] = [];
    const toasts: string[] = [];
    host = new PluginHost({
      dirs: [join(fixtures, "floater"), join(fixtures, "echo")],
      bun: process.execPath,
      host: { name: "test", version: "0" },
      data,
      agentCommand: () => ["/bun", "/cli.js", "--socket", "/agent.sock"],
    });
    host.subscribe({ plugins: () => {}, tree: (plugin, surface, tree) => trees.push({ plugin, surface, tree }), toast: (_p, t) => toasts.push(t), navigate: () => {} });
    host.start();
    host.open("floater", "floating");
    await until(() => trees.find((t) => t.plugin === "floater"));
    expect(trees.at(-1)!.tree).toMatchObject({ type: "floating", mode: "bar", suggestions: [{ id: "ask-hello" }] });
    host.event("floater", "floating", "send", { composer: "ask", text: "hi" });
    await until(() => trees.some((t) => (t.tree as { mode?: string }).mode === "panel"));
    host.event("floater", "floating", "env");
    await until(() => toasts.length);
    expect(toasts).toEqual(['agent ["/bun","/cli.js","--socket","/agent.sock"]']);
  });

  test("navigation follows the person's action, to declared screens only", async () => {
    const s = start();
    host!.open("echo", "screen:main");
    await until(() => s.trees.find((t) => t.surface === "screen:main"));
    expect(s.navigations).toEqual([]); // start-up navigation: nobody asked
    host!.event("echo", "screen:main", "go-nope");
    host!.event("echo", "screen:main", "go-main");
    await until(() => s.navigations.length);
    expect(s.navigations).toEqual(["echo/main/row-1"]);
  });

  test("each plugin gets its own data folder", async () => {
    const s = start();
    host!.open("echo", "screen:main");
    await until(() => s.trees.find((t) => t.surface === "screen:main"));
    host!.event("echo", "screen:main", "where");
    await until(() => s.toasts.includes(`data ${join(data, "echo")}`));
    expect(existsSync(join(data, "echo"))).toBe(true);
  });

  test("closed surfaces stop rendering", async () => {
    const s = start();
    host!.open("echo", "quick");
    await until(() => s.trees.find((t) => t.surface === "quick"));
    host!.close("echo", "quick");
    await Bun.sleep(100);
    const before = s.trees.length;
    host!.event("echo", "quick", "bump");
    await until(() => s.toasts.includes("now 1"));
    await Bun.sleep(100);
    expect(s.trees.length).toBe(before);
  });
  test("replacing a running package reopens existing viewers and sends a fresh tree", async () => {
    const s = start();
    host!.open("echo", "screen:main");
    await until(() => s.trees.some((t) => t.plugin === "echo"));
    const before = s.trees.length;
    const manifest = {
      ...host!.list().find((p) => p.manifest.id === "echo")!.manifest,
      version: "1.1.0",
    };
    await host!.activate({
      id: "echo",
      manifest,
      version: "1.1.0",
      packageRoot: join(fixtures, "echo"),
      repo: "test/echo",
      hash: "0".repeat(64),
      enabled: true,
      channel: "stable",
    } as import("../src/bun/packages").Installed);
    await until(() => s.trees.length > before);
    expect(count(s.trees.at(-1)?.tree)).toBe("count 0");
  });

  test("a plugin that keeps crashing ends up crashed, with its stderr", async () => {
    const s = start();
    const crashed = await until(
      () =>
        s
          .plugins()
          .find((p) => p.manifest.id === "crash" && p.state === "crashed"),
      15_000,
    );
    expect(crashed.error).toContain("failing on purpose");
  }, 20_000);

  test("a crash restarts the plugin and re-opens its surfaces", async () => {
    const s = start();
    host!.open("echo", "screen:main");
    await until(() => s.trees.find((t) => t.surface === "screen:main"));
    host!.event("echo", "screen:main", "boom");
    await until(
      () =>
        s.plugins().find((p) => p.manifest.id === "echo")?.state === "starting",
    );
    const n = s.trees.length;
    await until(() => s.trees.length > n, 5000); // rendered again after the restart
    expect(count(s.trees.at(-1)!.tree)).toBe("count 0");
  });
});

describe("the host checks each person's event against their screen", () => {
  let host: PluginHost | undefined;
  let root: string | undefined;
  afterEach(async () => {
    for (const p of host?.list() ?? []) await host!.stopPlugin(p.manifest.id);
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A plugin whose screen lists every event it heard; `delete` removes the row, `toast` offers Undo. */
  function start() {
    root = mkdtempSync(join(tmpdir(), "toolbelt-resolver-"));
    const dir = join(root, "heard");
    mkdirSync(dir);
    writeFileSync(join(dir, "toolbelt.json"), JSON.stringify({ id: "heard", name: "Heard", protocol: 2, agent: { access: "read" }, entry: "index.ts", screens: [{ id: "main", title: "Main" }] }));
    writeFileSync(
      join(dir, "index.ts"),
      `import { definePlugin } from ${JSON.stringify(join(import.meta.dir, "../src/sdk"))};
const heard = [];
let rows = ["a", "b"];
definePlugin({
  render: {
    "screen:main": () => ({
      type: "page",
      actions: [{ id: "toast", label: "Toast" }, { id: "off", label: "Off", disabled: true }],
      children: [
        { type: "table", id: "t", selectEvents: true, columns: [{ key: "n", title: "Name" }], actions: [{ id: "delete", label: "Delete" }, { id: "open", label: "Open", menu: [{ id: "open-in", label: "Open in…" }] }],
          rows: rows.map((id) => ({ id, cells: { n: id.toUpperCase() } })) },
        { type: "text", text: "heard " + JSON.stringify(heard) },
      ],
    }),
  },
  onEvent(surface, name, payload, ctx) {
    heard.push([surface, name, payload ?? null]);
    if (name === "delete") rows = rows.filter((r) => r !== payload.rowId);
    if (name === "toast") ctx.toast("Done", "success", { id: "undo", label: "Undo", payload: { rowId: "a" } });
    ctx.invalidate();
  },
});`,
    );
    const toasts: string[] = [];
    const logs: string[] = [];
    host = new PluginHost({ dirs: [root], bun: process.execPath, host: { name: "test", version: "0" }, data: join(root, "data"), diagnostic: (_p, kind, line) => kind === "stderr" && logs.push(String(line)) });
    host.subscribe({ plugins: () => {}, tree: () => {}, toast: (_p, t) => toasts.push(t) });
    host.start();
    const heard = () => {
      const tree = host!.snapshot("heard", "screen:main")?.tree as { children?: { type: string; text?: string }[] } | null | undefined;
      const text = tree?.children?.find((c) => c.type === "text")?.text;
      return text ? JSON.parse(text.slice("heard ".length)) : [];
    };
    return { toasts, logs, heard };
  }

  test("offered events reach the plugin unchanged; forged and stale ones never do", async () => {
    const s = start();
    await until(() => host!.list()[0]?.state === "running");
    // Nothing is shown yet: nothing can have been clicked.
    host!.event("heard", "screen:main", "delete", { rowId: "a" });
    expect(s.logs.at(-1)).toContain('refused "delete" on screen:main: nothing is shown there yet');
    host!.open("heard", "screen:main");
    await until(() => host!.snapshot("heard", "screen:main")?.tree);

    host!.event("heard", "screen:main", "open-in", { rowId: "b" });
    await until(() => s.heard().length === 1);
    expect(s.heard()).toEqual([["screen:main", "open-in", { rowId: "b" }]]);

    // Invented, disabled, unoffered on that row, extra payload: dropped, logged, the person told.
    host!.event("heard", "screen:main", "invented", {});
    host!.event("heard", "screen:main", "off", {});
    host!.event("heard", "screen:main", "delete", { rowId: "zzz" });
    host!.event("heard", "screen:main", "delete", { rowId: "a", text: "sneaky" });
    expect(s.logs.filter((l) => l.startsWith("refused"))).toHaveLength(5);
    expect(s.toasts.filter((t) => t === "That item changed. Try again.")).toHaveLength(5);

    // A stale click: the row went away before the second one arrived.
    host!.event("heard", "screen:main", "delete", { rowId: "a" });
    await until(() => s.heard().length === 2);
    host!.event("heard", "screen:main", "delete", { rowId: "a" });
    expect(s.logs.at(-1)).toContain(`row "a" isn't on the screen`);
    // A selection that went stale is dropped without a toast: the person didn't ask for it.
    const toasts = s.toasts.length;
    host!.event("heard", "screen:main", "select", { table: "t", rowId: "a" });
    expect(s.toasts.length).toBe(toasts);
    host!.event("heard", "screen:main", "select", { table: "t", rowId: "b" });
    await until(() => s.heard().length === 3);
    await Bun.sleep(100);
    expect(s.heard().map((e: unknown[]) => e[1])).toEqual(["open-in", "delete", "select"]);
  });

  test("a toast's button works while the host has seen that toast; a forged one doesn't", async () => {
    const s = start();
    host!.open("heard", "screen:main");
    await until(() => host!.snapshot("heard", "screen:main")?.tree);
    host!.event("heard", "toast", "undo", { rowId: "a" });
    expect(s.logs.at(-1)).toContain("no recent toast offers it");
    host!.event("heard", "screen:main", "toast", {});
    await until(() => s.toasts.includes("Done"));
    host!.event("heard", "toast", "undo", { rowId: "b" });
    host!.event("heard", "toast", "undo", { rowId: "a" });
    await until(() => s.heard().length === 2);
    await Bun.sleep(100);
    expect(s.heard()).toEqual([["screen:main", "toast", {}], ["toast", "undo", { rowId: "a" }]]);
  });
});
