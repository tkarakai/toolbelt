// The plugin host against real child processes (fixtures in test/fixtures).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_ANSWER, PluginHost, discover, pluginDirs, type EventSettled, type EventTag } from "../src/bun/host";
import { EventRoutes } from "../src/bun/event-routes";
import type { Node, ToastAction, ViewState } from "../src/shared/protocol";
import { LIMITS } from "../src/shared/package";
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
    expect(found.map((d) => d.manifest.id).sort()).toEqual(["acts", "crash", "echo", "floater"]);
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
    writeFileSync(join(dir, "toolbelt.json"), JSON.stringify({ id: "heard", name: "Heard", protocol: 3, agent: { access: "read" }, entry: "index.ts", screens: [{ id: "main", title: "Main" }] }));
    writeFileSync(
      join(dir, "index.ts"),
      `import { definePlugin } from ${JSON.stringify(join(import.meta.dir, "../src/sdk"))};
const heard = [];
let rows = ["a", "b"];
definePlugin({
  actions: { toast: { effect: "view" }, off: { effect: "write" }, delete: { effect: "destructive" }, open: { effect: "external" }, "open-in": { effect: "external" }, undo: { effect: "write" } },
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

describe("protocol 3: declarations, results, tags and instances (the acts fixture)", () => {
  let host: PluginHost | undefined;
  afterEach(async () => {
    if (host) await host.stopPlugin("acts");
    host = undefined;
  });

  function start() {
    const settled: EventSettled[] = [];
    const toasts: { text: string; action?: ToastAction; event?: EventTag }[] = [];
    const clipboard: { text: string; event?: EventTag }[] = [];
    const navigations: { screen: string; select?: string; event: EventTag }[] = [];
    const refusals: { instance: string; reason: string; view: ViewState }[] = [];
    const logs: string[] = [];
    host = new PluginHost({
      dirs: [join(fixtures, "acts")],
      bun: process.execPath,
      host: { name: "test", version: "0" },
      data,
      diagnostic: (_p, kind, line) => kind === "stderr" && logs.push(String(line)),
    });
    host.subscribe({
      plugins: () => {},
      tree: () => {},
      toast: (_p, text, _tone, action, event) => toasts.push({ text, action, event }),
      clipboard: (_p, text, event) => clipboard.push({ text, event }),
      navigate: (_p, screen, select, event) => navigations.push({ screen, select, event }),
      settled: (e) => settled.push(e),
      viewRefused: (_p, _s, instance, reason, view) => refusals.push({ instance, reason, view }),
    });
    host.start();
    const text = (instance?: string) => JSON.stringify(host!.snapshot("acts", "screen:main", instance)?.tree ?? null).match(/"text":"([^"]*\|[^"]*)"/)?.[1];
    const outcome = (id: string | null) => until(() => settled.find((e) => e.id === id));
    return { settled, toasts, clipboard, navigations, refusals, logs, text, outcome };
  }

  async function opened() {
    const s = start();
    await until(() => host!.list()[0]?.state === "running");
    host!.open("acts", "screen:main");
    await until(() => s.text()?.includes("open:screen:main:person:person"));
    return s;
  }

  test("each event gets an id and settles once with the plugin's result", async () => {
    const s = await opened();
    const ok = host!.event("acts", "screen:main", "ok", {});
    expect(ok).toMatch(/^[0-9a-f-]{36}$/);
    expect(await s.outcome(ok)).toEqual({ id: ok!, plugin: "acts", surface: "screen:main", name: "ok", actor: { kind: "person", via: "window" }, outcome: "ok" });
    expect((await s.outcome(host!.event("acts", "screen:main", "skip", {}))).outcome).toBe("not-handled");
    expect(await s.outcome(host!.event("acts", "screen:main", "fail", {}))).toMatchObject({ outcome: "error", error: "it broke" });
    const data = host!.event("acts", "screen:main", "data", {}, { kind: "person", via: "remote", device: "Phone" });
    expect(await s.outcome(data)).toMatchObject({ outcome: "ok", data: { created: "r-1", event: data }, actor: { kind: "person", via: "remote", device: "Phone" } });
    // View events are answered too: the SDK applies them.
    expect((await s.outcome(host!.event("acts", "screen:main", "search", { query: "x" }))).outcome).toBe("ok");
    // A refused event never reaches the plugin: no id, nothing settles.
    expect(host!.event("acts", "screen:main", "invented", {})).toBeNull();
    expect(new Set(s.settled.map((e) => e.id)).size).toBe(s.settled.length);
  });

  test("an event without a result in time settles as no answer; its late result is ignored", async () => {
    const s = await opened();
    const wait = LIMITS.resultMs;
    LIMITS.resultMs = 200;
    try {
      const id = host!.event("acts", "screen:main", "hang", {});
      expect(await s.outcome(id)).toMatchObject({ outcome: "no-answer", error: NO_ANSWER });
      await until(() => s.logs.some((l) => l.includes("result for an unknown or settled event ignored")));
      expect(s.settled.filter((e) => e.id === id)).toHaveLength(1);
    } finally {
      LIMITS.resultMs = wait;
    }
  });

  test("navigation tagged with an event goes to the view that sent it, once; untagged and late navigation is ignored", async () => {
    const s = await opened();
    const routes = new EventRoutes<string>();
    // The window and two paired devices each act; each navigation goes back to its sender.
    for (const [view, actor] of [
      ["window", { kind: "person", via: "window" }],
      ["phone", { kind: "person", via: "remote", device: "Phone" }],
      ["tablet", { kind: "person", via: "remote", device: "Tablet" }],
    ] as const) {
      const id = host!.event("acts", "screen:main", "go", {}, actor);
      routes.record(id, view);
      await s.outcome(id);
      const nav = await until(() => s.navigations.find((n) => n.event.id === id));
      expect(nav).toEqual({ screen: "other", select: "row-1", event: { id: id!, actor } });
      expect(routes.viewOf(nav.event.id)).toBe(view);
    }
    // One navigation per event (the second `navigate` in the handler), none from background work.
    await Bun.sleep(150);
    expect(s.navigations).toHaveLength(3);
    expect(s.logs.filter((l) => l.includes("the event already navigated"))).toHaveLength(3);
    expect(s.logs.filter((l) => l.includes("not in response to a recent event"))).toHaveLength(3);
  });

  test("toasts and clipboard text carry their event; a toast button must be declared", async () => {
    const s = await opened();
    const undo = host!.event("acts", "screen:main", "undo-toast", {});
    await until(() => s.toasts.find((t) => t.text === "Deleted"));
    expect(s.toasts.find((t) => t.text === "Deleted")).toEqual({ text: "Deleted", action: { id: "undo", label: "Undo" }, event: { id: undo!, actor: { kind: "person", via: "window" } } });
    // The declared Undo works like any toast button.
    expect(host!.event("acts", "toast", "undo", null)).not.toBeNull();
    host!.event("acts", "screen:main", "bad-toast", {});
    await until(() => s.toasts.find((t) => t.text === "Saved"));
    expect(s.toasts.find((t) => t.text === "Saved")!.action).toBeUndefined();
    expect(s.logs.some((l) => l.includes(`toast shown without its button: action "not-declared" isn't declared in actions`))).toBe(true);
    expect(host!.event("acts", "toast", "not-declared", null)).toBeNull();
    const copy = host!.event("acts", "screen:main", "copy", {});
    await until(() => s.clipboard.length);
    expect(s.clipboard).toEqual([{ text: "copied text", event: { id: copy!, actor: { kind: "person", via: "window" } } }]);
  });

  test("a render using an undeclared action id shows the render error, and offers nothing", async () => {
    const s = await opened();
    host!.event("acts", "screen:main", "break", {});
    await until(() => host!.snapshot("acts", "screen:main")?.error);
    expect(host!.snapshot("acts", "screen:main")).toMatchObject({ tree: null, error: `action "mend" (toolbar) isn't declared in actions` });
    expect(s.logs.some((l) => l.startsWith("Rejected a render of screen:main") && l.includes(`"mend"`))).toBe(true);
    expect(host!.list()[0].state).toBe("running");
    expect(host!.event("acts", "screen:main", "mend", {})).toBeNull();
    // The plugin's other screens keep working.
    host!.open("acts", "screen:other");
    await until(() => host!.snapshot("acts", "screen:other")?.tree);
  });

  test("onOpen and onClose fire for every instance with its origin; ctx.open keeps its surface meaning", async () => {
    const s = await opened();
    host!.open("acts", "screen:main", "agent:a", {});
    await until(() => s.text()?.includes("open:screen:main:agent:a:agent"));
    host!.close("acts", "screen:main", "agent:a");
    await until(() => s.text()?.includes("close:screen:main:agent:a:agent:open"));
    host!.close("acts", "screen:main");
    host!.open("acts", "screen:main");
    await until(() => s.text()?.includes("close:screen:main:person:person:closed"));
  });

  test("view refusals: values outside the declared options and onView's false keep the instance's view", async () => {
    const s = await opened();
    // An agent instance opening with a value outside the options starts from the defaults.
    host!.open("acts", "screen:main", "agent:bad", { controls: { mode: "grid" } });
    await until(() => s.refusals.length === 1);
    expect(s.refusals[0]).toEqual({ instance: "agent:bad", reason: `control "mode" has no option "grid"`, view: {} });
    await until(() => s.text("agent:bad")?.startsWith("agent:bad||list|"));
    expect(host!.instanceView("acts", "screen:main", "agent:bad")).toEqual({});
    // The host setting the person's view: refused by onView, the person's view stays.
    host!.setView("acts", "screen:main", "person", { search: "kept" });
    await until(() => s.text()?.startsWith("person|kept|"));
    host!.setView("acts", "screen:main", "person", { search: "no" });
    await until(() => s.refusals.length === 2);
    expect(s.refusals[1]).toEqual({ instance: "person", reason: "the plugin refused this view", view: { search: "kept" } });
    // A person's view event refused the same way: its result says so.
    const id = host!.event("acts", "screen:main", "search", { query: "no" });
    expect(await s.outcome(id)).toMatchObject({ outcome: "not-handled", error: "refused: the plugin refused this view" });
    expect(s.text()?.startsWith("person|kept|")).toBe(true);
  });
});
