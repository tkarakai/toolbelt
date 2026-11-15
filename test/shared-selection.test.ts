import { test, expect } from "bun:test";
import { createSelectionStore } from "../src/ui/lib/selection-store";
import { findSelectionTarget } from "../src/shared/navigation";
import { pointerTracker } from "../src/ui/lib/pane-navigation";
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test("fresh plugins start unselected; window and quick view share one item in both directions", () => {
  const backing = storage();
  const main = createSelectionStore(backing, "profile.selection.");
  const quick = createSelectionStore(backing, "profile.selection.");
  expect(quick.get("plugin")).toBeUndefined();
  main.set("plugin", { item: "item-b", collection: "table:main" });
  quick.refresh("profile.selection.plugin");
  expect(quick.get("plugin")).toEqual({ item: "item-b", collection: "table:main" });
  const target = findSelectionTarget({ type: "list", id: "quick", items: [{ id: "item-b", title: "B" }] }, quick.get("plugin")!);
  expect(target?.item).toBe("item-b");
  quick.set("plugin", { item: "item-c", collection: "list:quick" });
  main.refresh("profile.selection.plugin");
  expect(main.get("plugin")?.item).toBe("item-c");
  expect(findSelectionTarget({ type: "list", id: "short", items: [] }, main.get("plugin")!)).toBeNull();
  expect(main.get("plugin")?.item).toBe("item-c");
});
test("clearing a selection syncs, unrelated plugins and profiles remain independent", () => {
  const backing = storage();
  const first = createSelectionStore(backing, "a.selection.");
  const second = createSelectionStore(backing, "a.selection.");
  const separate = createSelectionStore(backing, "b.selection.");
  first.set("one", { item: "a" }); first.set("two", { item: "b" });
  second.refresh(null);
  expect(second.get("one")?.item).toBe("a");
  second.set("one", null); first.refresh("a.selection.one");
  expect(first.get("one")).toBeNull();
  expect(first.get("two")?.item).toBe("b");
  expect(separate.get("one")).toBeUndefined();
});

test("host relays update hidden views without echo loops", () => {
  const backing = storage();
  const messages: unknown[] = [];
  const first = createSelectionStore(backing, "a.selection.", (plugin, selection) => messages.push({ plugin, selection }));
  const hidden = createSelectionStore(backing, "a.selection.", () => { throw new Error("relay echoed"); });
  expect(hidden.get("one")).toBeUndefined();
  first.set("one", { item: "latest" });
  hidden.apply("one", { item: "latest" });
  first.apply("one", { item: "latest" });
  expect(hidden.get("one")?.item).toBe("latest");
  expect(messages).toHaveLength(1);
});

test("late copies of an older choice never move the selection back", () => {
  const backing = storage();
  let t = 1000;
  const sent: { selection: unknown; at: number }[] = [];
  const main = createSelectionStore(backing, "p.selection.", (_plugin, selection, at) => sent.push({ selection, at }), () => t);
  const quick = createSelectionStore(backing, "p.selection.", undefined, () => t);
  main.set("one", { item: "a" }); t += 10;
  main.set("one", { item: "b" }); t += 10;
  main.set("one", { item: "c" });
  // The host relays every choice back to every view, possibly late and out of order.
  main.apply("one", sent[0].selection as never, sent[0].at);
  main.apply("one", sent[1].selection as never, sent[1].at);
  expect(main.get("one")?.item).toBe("c");
  // The other view receives them out of order, too.
  quick.apply("one", sent[2].selection as never, sent[2].at);
  quick.apply("one", sent[0].selection as never, sent[0].at);
  expect(quick.get("one")?.item).toBe("c");
  // A storage event replaying an older saved value does not win either.
  backing.setItem("p.selection.one", JSON.stringify({ selection: { item: "a" }, at: sent[0].at }));
  main.refresh("p.selection.one");
  expect(main.get("one")?.item).toBe("c");
  // A newer choice from the other view does.
  t += 10;
  quick.set("one", { item: "d" });
  main.refresh("p.selection.one");
  expect(main.get("one")?.item).toBe("d");
});

test("selections saved by earlier builds still load", () => {
  const backing = storage();
  backing.setItem("p.selection.one", JSON.stringify({ item: "legacy", collection: "table:t" }));
  backing.setItem("p.selection.two", "null");
  const store = createSelectionStore(backing, "p.selection.");
  expect(store.get("one")).toEqual({ item: "legacy", collection: "table:t" });
  expect(store.get("two")).toBeNull();
  store.set("one", { item: "next" });
  expect(JSON.parse(backing.getItem("p.selection.one")!).selection).toEqual({ item: "next" });
});

test("hover follows real pointer moves, not content moving under a still pointer", () => {
  const moved = pointerTracker();
  expect(moved({ screenX: 10, screenY: 10 })).toBe(true);
  // mouseenter + mousemove of one move share coordinates; a re-sort under the pointer repeats them.
  expect(moved({ screenX: 10, screenY: 10 })).toBe(false);
  expect(moved({ screenX: 10, screenY: 10 })).toBe(false);
  expect(moved({ screenX: 11, screenY: 10 })).toBe(true);
});
