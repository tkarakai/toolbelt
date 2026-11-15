import { test, expect } from "bun:test";
import { protocolReason, validateTree, validateMessage } from "../src/shared/validation";
const table = (cell: unknown) => ({
  type: "table",
  id: "test",
  columns: [{ key: "x", title: "X" }],
  rows: [{ id: "a", cells: { x: cell } }],
});
test("decorated cells and nested renderer values reject React-crashing objects", () => {
  for (const cell of [
    { text: {} },
    {},
    { text: "okay", chips: [{}] },
    { text: "okay", tags: [{ text: {} }] },
    { text: "okay", spark: ["bad"] },
    { text: "okay", dot: { color: {} } },
  ])
    expect(() => validateTree(table(cell))).toThrow();
  expect(() =>
    validateTree(
      table({ text: "fine", chips: ["one"], spark: [1, 2], dot: "success" }),
    ),
  ).not.toThrow();
});
test("fields and nested action options are checked", () => {
  expect(() =>
    validateTree({
      type: "form",
      id: "x",
      fields: [
        {
          type: "select",
          id: "x",
          label: "X",
          value: "a",
          options: [{ label: {}, value: "a" }],
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    validateTree({
      type: "page",
      children: [],
      actions: [{ id: "a", label: {} }],
    }),
  ).toThrow();
  expect(() =>
    validateTree({ ...table("fine"), bulkActions: [{ id: "a", label: {} }] }),
  ).toThrow();
});
test("protocol metadata, unknown nodes, deep trees and non-finite values reject", () => {
  expect(() =>
    validateMessage({
      type: "hello",
      protocol: 1,
      sdk: "test",
      capabilities: [{}],
    }),
  ).toThrow();
  expect(() =>
    validateTree({ type: "arbitrary-html", html: "<script>" }),
  ).toThrow();
  let node: unknown = { type: "text", text: "hi" };
  for (let i = 0; i < 40; i++) node = { type: "stack", children: [node] };
  expect(() => validateTree(node)).toThrow();
  expect(() => validateTree(table(Infinity))).toThrow();
});
test('inherited object names and out-of-range dates cannot bypass runtime validation',()=>{expect(()=>validateTree({type:'constructor'})).toThrow();expect(()=>validateMessage({type:'constructor'})).toThrow();expect(()=>validateTree({type:'stats',items:[{label:'date',value:'bad',at:1e100}]})).toThrow()});

test("group summary column keys are optional strings", () => {
 const tree = (column: unknown) => ({...table("fine"),rows:[{id:"a",cells:{x:"fine"},group:[{label:"Group",summary:{label:"Total",value:"42",column}}]}]});
 for (const column of [undefined,"x","missing"]) expect(()=>validateTree(JSON.parse(JSON.stringify(tree(column))))).not.toThrow();
 for (const column of [12,{},null]) expect(()=>validateTree(tree(column))).toThrow();
});

test("toolbar controls only accept segmented choices with text explanations", () => {
 const control = {type:"segmented", id:"scope", label:"Scope", value:"work", options:[{value:"work",label:"Work",tooltip:"Commands you started"}]};
 expect(() => validateTree({type:"page", controls:[control], children:[]})).not.toThrow();
 expect(() => validateTree(control)).not.toThrow();
 for (const invalid of [
  {...control, type:"text"},
  {...control, label:{}},
  {...control, options:[{value:"work",label:"Work",tooltip:{}}]},
  {...control, value:false},
 ]) expect(() => validateTree({type:"page", controls:[invalid], children:[]})).toThrow();
 expect(() => validateTree({type:"page",controls:{},children:[]})).toThrow();
});
test("column layout fields and table overflow are checked", () => {
  const withColumn = (column: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ...table("fine"), columns: [{ key: "x", title: "X", ...column }], ...extra });
  for (const column of [
    { width: 120, minWidth: 40, maxWidth: 300, shrink: 1, resizable: false, reorderable: true },
    { width: "content" },
    { grow: true },
    { grow: 2 },
  ])
    expect(() => validateTree(withColumn(column))).not.toThrow();
  expect(() => validateTree(withColumn({}, { overflow: "scroll", layoutVersion: 2 }))).not.toThrow();
  for (const column of [{ width: "auto" }, { width: -1 }, { grow: "yes" }, { minWidth: Infinity }, { shrink: -1 }, { reorderable: 1 }])
    expect(() => validateTree(withColumn(column))).toThrow();
  expect(() => validateTree(withColumn({}, { overflow: "wrap" }))).toThrow();
});
test("split-button alternatives are one level of plain actions", () => {
  const page = (action: unknown) => ({ type: "page", actions: [action], children: [] });
  const alt = { id: "review", label: "Review first", icon: "eye", key: "r", confirm: "Sure?" };
  expect(() => validateTree(page({ id: "update", label: "Update", menu: [alt] }))).not.toThrow();
  expect(() => validateTree(page({ id: "update", label: "Update", menu: [{ ...alt, menu: [] }] }))).toThrow();
  expect(() => validateTree(page({ id: "update", label: "Update", menu: [{ ...alt, checked: true }] }))).toThrow();
  expect(() => validateTree(page({ id: "update", label: "Update", checked: true, menu: [alt] }))).toThrow();
  expect(() => validateTree(page({ id: "update", label: "Update", menu: [{ id: "x" }] }))).toThrow();
  expect(() => validateTree(page({ id: "update", label: "Update", menu: {} }))).toThrow();
});
test("navigate messages name a screen and optionally an item", () => {
  expect(() => validateMessage({ type: "navigate", screen: "queue" })).not.toThrow();
  expect(() => validateMessage({ type: "navigate", screen: "queue", select: "job-1" })).not.toThrow();
  expect(() => validateMessage({ type: "navigate" })).toThrow();
  expect(() => validateMessage({ type: "navigate", screen: "queue", select: 3 })).toThrow();
});
test("refused trees say which limit or field was wrong", () => {
  let deep: unknown = { type: "text", text: "leaf" };
  for (let i = 0; i < 40; i++) deep = { type: "stack", children: [deep] };
  expect(() => validateTree(deep)).toThrow("nested deeper than 32 levels");
  const wide = { type: "list", id: "l", items: Array.from({ length: 20_000 }, (_, i) => ({ id: String(i), title: "x" })) };
  expect(() => validateTree(wide)).toThrow("more than 50000 values");
  expect(() => validateTree(table({ text: {} }))).toThrow("Invalid protocol value at tree.");
  expect(protocolReason(new Error("short"))).toBe("short");
  expect(protocolReason(new Error("x".repeat(500))).length).toBe(200);
});

const form = (field: unknown) => ({ type: "form", id: "f", fields: [field] });
test("rich fields check their values", () => {
  const good = [
    { type: "textarea", id: "d", label: "D", value: "# hi", markdown: true, rows: 6 },
    { type: "datetime", id: "w", label: "W", value: "" },
    { type: "datetime", id: "w", label: "W", value: "2026-02-28" },
    { type: "datetime", id: "w", label: "W", value: "2026-11-20T09:05" },
    { type: "color", id: "c", label: "C", value: "teal" },
    { type: "combobox", id: "t", label: "T", value: "x", options: [{ value: "1", label: "One", sub: "#1" }], freeform: true },
    { type: "tags", id: "l", label: "L", value: [{ key: "p", value: "High" }, { key: "f" }], keys: [{ key: "p", label: "Priority", color: "orange", values: ["High"] }, { key: "f", label: "Flag", flag: true }] },
  ];
  for (const f of good) expect(() => validateTree(form(f))).not.toThrow();
  const bad = [
    { type: "textarea", id: "d", label: "D", value: "", rows: 0 },
    { type: "datetime", id: "w", label: "W", value: "2026-02-30" },
    { type: "datetime", id: "w", label: "W", value: "2026-11-20T24:00" },
    { type: "datetime", id: "w", label: "W", value: "2026-11-20T10:00", time: false },
    { type: "color", id: "c", label: "C", value: "magenta" },
    { type: "combobox", id: "t", label: "T", value: "x", options: [{ value: 1, label: "One" }] },
    { type: "tags", id: "l", label: "L", value: [{ key: "zzz" }], keys: [{ key: "p", label: "P" }] },
    { type: "tags", id: "l", label: "L", value: [{ key: "p" }, { key: "p" }], keys: [{ key: "p", label: "P" }] },
    { type: "tags", id: "l", label: "L", value: [], keys: [{ key: "p", label: "P" }, { key: "p", label: "Q" }] },
  ];
  for (const f of bad) expect(() => validateTree(form(f))).toThrow();
});
test("tables accept sections, reorder, select events and unread rows", () => {
  const tree = {
    type: "table",
    id: "t",
    columns: [{ key: "x", title: "X" }],
    rows: [{ id: "a", cells: { x: "A" }, group: "inbox", unread: true }],
    sections: [{ id: "inbox", label: "Inbox", empty: "Nothing new" }, { id: "settled", label: "Settled", collapsed: true, order: "fixed", dropLabel: "Settle", dropIcon: "check" }, { id: "snoozed", label: "Snoozed", order: false }],
    reorder: true,
    selectEvents: true,
  };
  expect(() => validateTree(tree)).not.toThrow();
  expect(() => validateTree({ ...tree, sections: [{ id: "x", label: "X", order: "random" }] })).toThrow();
  expect(() => validateTree({ ...tree, rows: [{ id: "a", cells: { x: "A" }, unread: "yes" }] })).toThrow();
  expect(() => validateTree({ type: "list", id: "l", items: [{ id: "1", title: "T", unread: true }] })).not.toThrow();
});
test("action keys are one key, or alt/shift before a key or arrow", () => {
  const withKey = (key: string) => ({ type: "page", actions: [{ id: "a", label: "A", key }], children: [] });
  for (const key of ["j", "alt+up", "alt+shift+down", "shift+s", "alt+1"]) expect(() => validateTree(withKey(key))).not.toThrow();
  for (const key of ["up", "jj", "ctrl+a", "cmd+s", "shift+alt+x", "alt+"]) expect(() => validateTree(withKey(key))).toThrow();
});
