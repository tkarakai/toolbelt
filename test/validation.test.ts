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
