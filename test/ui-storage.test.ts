import { test, expect } from "bun:test";
import { readUIEntries, writeUIEntry } from "../src/ui/lib/ui-storage";
function storage() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
test("independent main/popover saves preserve preferences from both snapshots", () => {
  const store = storage();
  const main = new Map(readUIEntries(store, "profile.ui"));
  const popover = new Map(readUIEntries(store, "profile.ui"));
  main.set("plugin/screen:main\nselected", "row-b");
  popover.set("plugin/quick\nactive", "row-c");
  for (const [key, value] of popover) writeUIEntry(store, "profile.ui", key, value);
  for (const [key, value] of main) writeUIEntry(store, "profile.ui", key, value);
  expect(Object.fromEntries(readUIEntries(store, "profile.ui"))).toEqual({
    "plugin/screen:main\nselected": "row-b", "plugin/quick\nactive": "row-c",
  });
});
test("legacy values migrate on write, corrupted entries are contained, profiles stay separate", () => {
  const store = storage();
  store.setItem("a.ui", JSON.stringify({ selected: "old", expanded: ["parent"] }));
  writeUIEntry(store, "a.ui", "selected", "new");
  writeUIEntry(store, "b.ui", "selected", "other-profile");
  store.setItem("a.ui.entry.%broken", "invalid");
  expect(Object.fromEntries(readUIEntries(store, "a.ui"))).toEqual({ selected: "new", expanded: ["parent"] });
  expect(Object.fromEntries(readUIEntries(store, "b.ui"))).toEqual({ selected: "other-profile" });
});
