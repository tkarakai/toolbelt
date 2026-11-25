// Views (docs/plugins.md, Views): what a surface instance shows — its search, filters, sort and
// page controls. Pure functions shared by the SDK, which owns each instance's view, and the host,
// which saves the person's and cleans what agents ask for the same way.
import type { Node, ViewDeclaration, ViewState } from "./protocol";

/**
 * The view an instance renders with: its declared defaults overlaid with what the person (or the
 * agent that opened it) chose. `instance` is `PERSON` for every person's screen, `agent:…` for
 * an agent's private one; key per-viewer state such as an open dialog by it.
 */
export type View = {
  readonly instance: string;
  readonly search: string;
  readonly filters: Readonly<Record<string, string[]>>;
  readonly sort: Readonly<Record<string, { key: string; desc: boolean } | null>>;
  readonly controls: Readonly<Record<string, string>>;
  readonly arrange: { order: string[]; grouped: string[] } | null;
};

const MAX_TEXT = 1000;
const MAX_VALUES = 200;

/** A view state reduced to what the declaration has, with values of the right shapes. */
export function cleanView(declared: ViewDeclaration | undefined, view: unknown): ViewState {
  const v = view && typeof view === "object" ? (view as Record<string, any>) : {};
  const out: ViewState = {};
  if (!declared) return out;
  const str = (x: unknown) => typeof x === "string" && x.length <= MAX_TEXT;
  if (declared.search && str(v.search) && v.search) out.search = v.search;
  for (const [id] of Object.entries(declared.filters ?? {})) {
    const values = v.filters?.[id];
    if (Array.isArray(values) && values.length <= MAX_VALUES && values.every(str))
      (out.filters ??= {})[id] = [...new Set<string>(values)];
  }
  for (const [id] of Object.entries(declared.sort ?? {})) {
    const s = v.sort?.[id];
    if (s && str(s.key) && s.key && typeof s.desc === "boolean")
      (out.sort ??= {})[id] = { key: s.key, desc: s.desc };
  }
  for (const [id] of Object.entries(declared.controls ?? {}))
    if (str(v.controls?.[id])) (out.controls ??= {})[id] = v.controls[id];
  const a = v.arrange;
  if (declared.arrange && a && Array.isArray(a.order) && Array.isArray(a.grouped) && a.order.every(str) && a.grouped.every(str))
    out.arrange = { order: [...a.order], grouped: a.grouped.filter((g: string) => a.order.includes(g)) };
  return out;
}

/** The declared defaults overlaid with an instance's state. */
export function resolveView(declared: ViewDeclaration | undefined, state: ViewState, instance: string): View {
  return {
    instance,
    search: state.search ?? "",
    filters: { ...(declared?.filters ?? {}), ...(state.filters ?? {}) },
    sort: { ...(declared?.sort ?? {}), ...(state.sort ?? {}) },
    controls: { ...(declared?.controls ?? {}), ...(state.controls ?? {}) },
    arrange: state.arrange ?? declared?.arrange ?? null,
  };
}

/** Writes the view into the tree's view controls: the search box, filters, sorted tables, controls. */
export function applyView(tree: Node, view: View, declared: ViewDeclaration | undefined): Node {
  if (!declared || tree.type !== "page") return tree;
  const page = { ...tree };
  if (page.search && declared.search) page.search = { ...page.search, query: view.search };
  if (page.filters)
    page.filters = page.filters.map((f) =>
      declared.filters && Object.hasOwn(declared.filters, f.id) ? { ...f, selected: view.filters[f.id] ?? [] } : f,
    );
  if (page.controls)
    page.controls = page.controls.map((c) =>
      declared.controls && Object.hasOwn(declared.controls, c.id) && view.controls[c.id] !== undefined ? { ...c, value: view.controls[c.id] } : c,
    );
  const sortTables = (nodes: Node[]): Node[] =>
    nodes.map((n) => {
      if (n.type === "table" && declared.sort && Object.hasOwn(declared.sort, n.id)) {
        const s = view.sort[n.id];
        const { sort: _old, ...rest } = n;
        return (s ? { ...rest, sort: s } : rest) as Node;
      }
      if (n.type === "stack") return { ...n, children: sortTables(n.children) };
      return n;
    });
  page.children = sortTables(page.children);
  return page;
}

/** The view event an SDK-owned view applies, or null when the plugin handles the event itself. */
export function viewChange(declared: ViewDeclaration | undefined, state: ViewState, name: string, payload: any): ViewState | null {
  if (!declared) return null;
  const p = payload && typeof payload === "object" ? payload : {};
  if (name === "search" && declared.search) return { ...state, search: String(p.query ?? "").slice(0, MAX_TEXT) };
  if (name === "filter" && declared.filters && Object.hasOwn(declared.filters, p.filter))
    return { ...state, filters: { ...state.filters, [p.filter]: Array.isArray(p.values) ? p.values.map(String) : [] } };
  if (name === "filter-arrange" && declared.arrange)
    return { ...state, arrange: { order: Array.isArray(p.order) ? p.order.map(String) : [], grouped: Array.isArray(p.grouped) ? p.grouped.map(String) : [] } };
  if (name === "sort" && declared.sort && Object.hasOwn(declared.sort, p.table))
    return { ...state, sort: { ...state.sort, [p.table]: { key: String(p.key), desc: p.desc === true } } };
  if (name === "field" && declared.controls && p.form === p.field && Object.hasOwn(declared.controls, p.field))
    return { ...state, controls: { ...state.controls, [p.field]: String(p.value) } };
  return null;
}

