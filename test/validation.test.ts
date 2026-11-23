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
    { type: "datetime", id: "w", label: "W", value: "", placeholder: "No due date", autofocus: true, presets: [{ label: "Later", value: "2026-11-20T18:00" }, { label: "Friday", value: "2026-11-20" }] },
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
    { type: "datetime", id: "w", label: "W", value: "", presets: [{ label: "Never", value: "" }] },
    { type: "datetime", id: "w", label: "W", value: "", time: false, presets: [{ label: "Later", value: "2026-11-20T18:00" }] },
    { type: "datetime", id: "w", label: "W", value: "", presets: [{ label: "Bad", value: "2026-02-30" }] },
    { type: "text", id: "w", label: "W", value: "", autofocus: "yes" },
    { type: "color", id: "c", label: "C", value: "magenta" },
    { type: "combobox", id: "t", label: "T", value: "x", options: [{ value: 1, label: "One" }] },
    { type: "tags", id: "l", label: "L", value: [{ key: "zzz" }], keys: [{ key: "p", label: "P" }] },
    { type: "tags", id: "l", label: "L", value: [{ key: "p" }, { key: "p" }], keys: [{ key: "p", label: "P" }] },
    { type: "tags", id: "l", label: "L", value: [], keys: [{ key: "p", label: "P" }, { key: "p", label: "Q" }] },
  ];
  for (const f of bad) expect(() => validateTree(form(f))).toThrow();
});
test("timelines check their entries", () => {
  const tree = {
    type: "timeline",
    id: "updates",
    entries: [
      { id: "1", at: 1_700_000_000_000, text: "**Started**", edited: 1_700_000_100_000, author: "you", title: "Kickoff", actions: ["edit"] },
      { id: "2", at: 1_700_000_200_000, text: "Done" },
    ],
    actions: [{ id: "edit", label: "Edit", key: "e" }, { id: "delete", label: "Delete", tone: "destructive", confirm: "Delete?" }],
    selected: "1",
    empty: { title: "No updates" },
  };
  expect(() => validateTree(tree)).not.toThrow();
  expect(() => validateTree({ ...tree, entries: [] })).not.toThrow();
  expect(() => validateTree({ ...tree, entries: [tree.entries[0], tree.entries[0]] })).toThrow();
  expect(() => validateTree({ ...tree, entries: [{ id: "1", text: "no time" }] })).toThrow();
  expect(() => validateTree({ ...tree, entries: [{ id: "1", at: 1, text: 5 }] })).toThrow();
});
test("detail items can be Markdown and carry a target", () => {
  const table = (details: unknown[]) => ({ type: "table", id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "a", cells: { x: "A" }, details }] });
  expect(() => validateTree(table([{ label: "", value: "# Hi", markdown: true, target: "u1", actions: [{ id: "edit", label: "Edit" }] }]))).not.toThrow();
  expect(() => validateTree(table([{ label: "x", value: "y", markdown: "yes" }]))).toThrow();
  expect(() => validateTree(table([{ label: "x", value: "y", target: 1 }]))).toThrow();
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
test("sections take sub-sections one level deep, with ids unique in the table", () => {
  const table = (sections: unknown) => ({ type: "table", id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "a", cells: { x: "A" }, group: "snoozed" }], sections });
  const sub = { id: "snoozed", label: "Snoozed", empty: "Nothing snoozed", collapsed: true, order: "fixed", dropLabel: "Snooze", dropIcon: "alarm-clock" };
  expect(() => validateTree(table([{ id: "progressing", label: "Progressing", sections: [{ id: "working", label: "Working" }, sub] }, { id: "settled", label: "Settled", sections: [] }]))).not.toThrow();
  expect(() => validateTree(table([{ id: "progressing", label: "Progressing", sections: [{ ...sub, sections: [{ id: "deeper", label: "Deeper" }] }] }]))).toThrow("sections[0].sections[0].sections");
  expect(() => validateTree(table([{ id: "progressing", label: "Progressing", sections: [{ ...sub, order: "random" }] }]))).toThrow();
  expect(() => validateTree(table([{ id: "progressing", label: "Progressing", sections: { id: "x", label: "X" } }]))).toThrow();
  expect(() => validateTree(table([{ id: "snoozed", label: "Snoozed" }, { id: "progressing", label: "Progressing", sections: [sub] }]))).toThrow("sections[1].sections[0].id");
  expect(() => validateTree(table([{ id: "progressing", label: "Progressing", sections: [sub, sub] }]))).toThrow();
  expect(() => validateTree(table([{ id: "inbox", label: "Inbox" }, { id: "inbox", label: "Inbox again" }]))).toThrow("sections[1].id");
});
test("action keys are one key, or alt/shift before a key or arrow", () => {
  const withKey = (key: string) => ({ type: "page", actions: [{ id: "a", label: "A", key }], children: [] });
  for (const key of ["j", "alt+up", "alt+shift+down", "shift+s", "alt+1"]) expect(() => validateTree(withKey(key))).not.toThrow();
  for (const key of ["up", "jj", "ctrl+a", "cmd+s", "shift+alt+x", "alt+"]) expect(() => validateTree(withKey(key))).toThrow();
});
test("tables accept the document appearance, and tags a shade from 0 to 1", () => {
  const table = (extra: object, cell: object = { text: "A" }) => ({ type: "table", id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "a", cells: { x: cell } }], ...extra });
  expect(() => validateTree(table({ appearance: "document" }))).not.toThrow();
  expect(() => validateTree(table({ appearance: "grid" }))).not.toThrow();
  expect(() => validateTree(table({ appearance: "paper" }))).toThrow();
  for (const shade of [0, 0.5, 1]) expect(() => validateTree(table({}, { text: "A", tags: [{ text: "High", color: "orange", shade }] }))).not.toThrow();
  for (const shade of [-0.1, 1.5, "1", Number.NaN]) expect(() => validateTree(table({}, { text: "A", tags: [{ text: "High", color: "orange", shade }] }))).toThrow();
  const tags = (shades: unknown) => ({ type: "form", id: "f", fields: [{ type: "tags", id: "l", label: "L", value: [], keys: [{ key: "p", label: "P", values: ["High", "Low"], shades }] }] });
  expect(() => validateTree(tags({ High: 1, Low: 0 }))).not.toThrow();
  expect(() => validateTree(tags({ High: 2 }))).toThrow();
});
test("cells and list titles take a text style: a tone or hue, bold and italic", () => {
  const table = (style: unknown) => ({ type: "table", id: "t", columns: [{ key: "x", title: "X" }], rows: [{ id: "a", cells: { x: { text: "A", style } } }] });
  const list = (titleStyle: unknown) => ({ type: "list", id: "l", items: [{ id: "1", title: "T", titleStyle, dot: "danger" }] });
  for (const style of [{ color: "danger" }, { color: "violet", bold: true }, { italic: true }, {}]) {
    expect(() => validateTree(table(style))).not.toThrow();
    expect(() => validateTree(list(style))).not.toThrow();
  }
  for (const style of [{ color: "crimson" }, { bold: "yes" }, { italic: 1 }, "danger"]) {
    expect(() => validateTree(table(style))).toThrow();
    expect(() => validateTree(list(style))).toThrow();
  }
});
test("rows can carry a pane of inline forms, composers and editable timelines", () => {
  const pane = [
    {
      type: "form",
      id: "task",
      appearance: "inline",
      fields: [
        { type: "text", id: "name", label: "", value: "Ship it", heading: true },
        { type: "datetime", id: "due", label: "Due", value: "", placeholder: "No due date" },
        { type: "textarea", id: "desc", label: "", value: "", markdown: true, placeholder: "Add a description…" },
      ],
    },
    {
      type: "card",
      id: "updates",
      title: "Updates",
      children: [
        { type: "composer", id: "update", placeholder: "What changed?", action: { id: "add-update", label: "Add update", icon: "send" } },
        { type: "timeline", id: "u", entries: [{ id: "1", at: 1_700_000_000_000, text: "Hi" }], edit: { id: "edit-text", label: "Edit", key: "e" } },
      ],
    },
  ];
  const tree = (row: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "table",
    id: "t",
    columns: [{ key: "x", title: "X" }],
    rows: [{ id: "a", cells: { x: "A" }, ...row }],
    actions: [{ id: "add-update", label: "Add update", focus: "update" }, { id: "note", label: "Note", input: { placeholder: "Say something" } }],
    ...extra,
  });
  expect(() => validateTree(tree({ pane }, { enter: "add-update" }))).not.toThrow();
  expect(() => validateTree(tree({ pane: [] }))).not.toThrow();
  expect(() => validateTree(tree({ pane: [{ type: "nope" }] }))).toThrow();
  expect(() => validateTree(tree({ pane }, { enter: 1 }))).toThrow();
  expect(() => validateTree({ type: "form", id: "f", appearance: "boxed", fields: [] })).toThrow();
  expect(() => validateTree({ type: "form", id: "f", fields: [{ type: "text", id: "n", label: "N", value: "", heading: "yes" }] })).toThrow();
  expect(() => validateTree({ type: "list", id: "l", items: [{ id: "1", title: "T", actions: [{ id: "a", label: "A", input: { placeholder: 1 } }] }] })).toThrow();
  expect(() => validateTree({ type: "list", id: "l", items: [{ id: "1", title: "T", actions: [{ id: "a", label: "A", focus: 3 }] }] })).toThrow();
});
test("composers check their action, line mode and key", () => {
  const composer = { type: "composer", id: "new", action: { id: "add", label: "Add task" }, placeholder: "New task", single: true, key: "n" };
  expect(() => validateTree(composer)).not.toThrow();
  expect(() => validateTree({ type: "composer", id: "new", action: { id: "add", label: "Add" } })).not.toThrow();
  expect(() => validateTree({ ...composer, action: undefined })).toThrow();
  expect(() => validateTree({ ...composer, key: "shift+n" })).toThrow();
  expect(() => validateTree({ ...composer, single: "yes" })).toThrow();
  expect(() => validateTree({ type: "timeline", id: "u", entries: [], edit: { id: 1, label: "Edit" } })).toThrow();
});

test("a toast button may carry a ⌘ shortcut the host doesn't own", () => {
  const toast = (key: unknown) => ({ type: "toast", text: "Settled #3", action: { id: "undo", label: "Undo", ...(key === undefined ? {} : { key }) } });
  for (const key of ["cmd+z", "cmd+shift+z", "cmd+u", undefined]) expect(() => validateMessage(toast(key))).not.toThrow();
  for (const key of ["z", "alt+z", "cmd+", "cmd+1", "cmd+alt+z", "shift+cmd+z", "cmd+zz", "cmd+Z", "cmd+c", "cmd+v", "cmd+q", "cmd+w", 3])
    expect(() => validateMessage(toast(key))).toThrow();
});
