import { expect, test } from "bun:test";
import { findSelectionTarget } from "../src/shared/navigation";
import type { Node } from "../src/shared/protocol";

test("selection crosses list/table surfaces by stable item ID and opens its ancestors/groups", () => {
  const main: Node = { type: "table", id: "main", columns: [], rows: [
    { id: "parent", cells: {}, group: [{ id: "host", label: "Machine" }, "Folder"], children: [{ id: "child", cells: {} }] },
  ] };
  expect(findSelectionTarget(main, { item: "child", collection: "list:quick" })).toEqual({
    item: "child", collection: "table:main", ancestors: ["parent"], groups: ["\0host", "\0host\0Folder"],
  });
});
test("matching collection wins when item IDs repeat across collections", () => {
  const tree: Node = { type: "page", children: [
    { type: "list", id: "a", items: [{ id: "same", title: "First" }] },
    { type: "list", id: "b", items: [{ id: "same", title: "Second" }] },
  ] };
  expect(findSelectionTarget(tree, { item: "same", collection: "list:b" })?.collection).toBe("list:b");
});
test("missing items never match by label or change unrelated selections", () => {
  expect(findSelectionTarget({ type: "list", id: "a", items: [{ id: "other", title: "missing" }] }, { item: "missing" })).toBeNull();
});

test("group-header handoff opens enclosing groups without selecting an unrelated row", () => {
  const tree: Node = { type: "table", id: "main", columns: [], rows: [
    { id: "row", cells: {}, group: ["Outer", "Inner"] },
  ] };
  expect(findSelectionTarget(tree, { item: "\u0001group:\0Outer\0Inner" })).toEqual({
    item: "\u0001group:\0Outer\0Inner", collection: "table:main", ancestors: [], groups: ["\0Outer"],
  });
});
