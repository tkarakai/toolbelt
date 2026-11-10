// The plugin host against real child processes (fixtures in test/fixtures).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, discover, pluginDirs } from "../src/bun/host";
import type { Node } from "../src/shared/protocol";
import type { PluginInfo } from "../src/shared/rpc";

const fixtures = join(import.meta.dir, "fixtures");
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
    expect(found.map((d) => d.manifest.id).sort()).toEqual(["crash", "echo"]);
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
    });
    host.start();
    return { trees, toasts, plugins: () => plugins };
  }

  test("opens a surface, relays events, badges and toasts", async () => {
    const s = start();
    expect(host!.open("echo", "screen:main")).toBeNull();
    await until(() => s.trees.find((t) => t.surface === "screen:main"));
    expect(s.trees.at(-1)!.tree).toEqual({ type: "text", text: "count 0" });

    host!.event("echo", "screen:main", "bump");
    await until(() =>
      s.trees.some((t) => JSON.stringify(t.tree).includes("count 1")),
    );
    await until(() => s.toasts.includes("now 1"));
    await until(
      () => s.plugins().find((p) => p.manifest.id === "echo")?.badge === 1,
    );

    // A second viewer gets the cached tree right away.
    expect(host!.open("echo", "screen:main")).toEqual({
      type: "text",
      text: "count 1",
    });
  });

  test("each plugin gets its own data folder", async () => {
    const s = start();
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
    const count = s.trees.length;
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
    await until(() => s.trees.length > count);
    expect(s.trees.at(-1)?.tree).toEqual({ type: "text", text: "count 0" });
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
    expect(s.trees.at(-1)!.tree).toEqual({ type: "text", text: "count 0" });
  });
});
