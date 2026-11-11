import { test, expect } from "bun:test";
import { createSelectionStore } from "../src/ui/lib/selection-store";
import { findSelectionTarget } from "../src/shared/navigation";
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
