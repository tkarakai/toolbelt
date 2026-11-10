import { test, expect } from "bun:test";
import { validateTree, validateMessage } from "../src/shared/validation";
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
