import { LIMITS } from "./package";
import type { Node, PluginMessage } from "./protocol";

type Schema = (value: unknown, path: string) => void;
const fail = (path: string): never => {
  throw new Error(`Invalid protocol value at ${path}`);
};
const text: Schema = (v, p) => {
  if (typeof v !== "string") fail(p);
};
const bool: Schema = (v, p) => {
  if (typeof v !== "boolean") fail(p);
};
const number: Schema = (v, p) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(p);
};
const timestamp: Schema = (v, p) => {
  number(v, p);
  if (Math.abs(v as number) > 8.64e15) fail(p);
};
const any: Schema = () => {};
const optional =
  (schema: Schema): Schema =>
  (v, p) => {
    if (v !== undefined) schema(v, p);
  };
const array =
  (schema: Schema): Schema =>
  (v, p) => {
    if (!Array.isArray(v)) fail(p);
    (v as unknown[]).forEach((x, i) => schema(x, `${p}[${i}]`));
  };
const enumeration =
  (...values: unknown[]): Schema =>
  (v, p) => {
    if (!values.includes(v)) fail(p);
  };
const object =
  (properties: Record<string, Schema>): Schema =>
  (v, p) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(p);
    for (const [key, schema] of Object.entries(properties))
      schema((v as any)[key], `${p}.${key}`);
  };
const record =
  (schema: Schema): Schema =>
  (v, p) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(p);
    for (const [key, x] of Object.entries(v as Record<string, unknown>))
      schema(x, `${p}.${key}`);
  };
const union =
  (...schemas: Schema[]): Schema =>
  (v, p) => {
    for (const schema of schemas) {
      try {
        schema!(v, p);
        return;
      } catch {}
    }
    fail(p);
  };
const literal = (value: unknown): Schema => enumeration(value);
const tone = enumeration(
  "default",
  "muted",
  "success",
  "warning",
  "danger",
  "info",
);
const hue = enumeration(
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "slate",
  "stone",
);
const color = union(tone, hue);
const dot = union(
  color,
  object({
    color,
    label: optional(text),
    pulse: optional(bool),
    dim: optional(bool),
  }),
);
const action = object({
  id: text,
  label: text,
  icon: optional(text),
  tone: optional(enumeration("default", "destructive")),
  confirm: optional(text),
  inline: optional(bool),
  primary: optional(bool),
  disabled: optional(bool),
  group: optional(text),
  checked: optional(bool),
  key: optional((v, p) => {
    text(v, p);
    if ((v as string).length !== 1) fail(p);
  }),
});
const actions = optional(array(action));
const tag = object({
  text,
  color: optional(color),
  icon: optional(text),
  tooltip: optional(text),
});
const mark = object({ icon: text, tooltip: text, color: optional(color) });
const cell = union(
  text,
  number,
  literal(null),
  object({
    text,
    sub: optional(text),
    mono: optional(bool),
    tone: optional(tone),
    dot: optional(dot),
    strong: optional(text),
    tags: optional(array(tag)),
    marks: optional(array(mark)),
    chips: optional(array(text)),
    badge: optional(bool),
    spark: optional(array(number)),
    at: optional(timestamp),
    icon: optional(text),
  }),
);
const target = object({
  id: text,
  label: text,
  sub: optional(text),
  icon: optional(text),
});
const detail = object({
  label: text,
  value: text,
  mono: optional(bool),
  tone: optional(tone),
  section: optional(text),
  copy: optional(bool),
  dot: optional(dot),
  actions,
  actionRow: optional(text),
});
const stat = object({
  label: text,
  value: text,
  spark: optional(array(number)),
  tone: optional(tone),
});
const group = union(
  text,
  object({
    id: optional(text),
    label: text,
    strong: optional(text),
    sub: optional(text),
    tag: optional(text),
    summary: optional(
      object({ label: text, value: text, description: optional(text) }),
    ),
    muted: optional(bool),
    icon: optional(text),
  }),
);
const row: Schema = (v, p) =>
  object({
    id: text,
    cells: record(cell),
    group: optional(union(text, array(group))),
    open: optional(bool),
    actions: optional(array(text)),
    details: optional(array(detail)),
    stats: optional(array(stat)),
    children: optional(array(row)),
    targets: optional(record(array(target))),
  })(v, p);
const column = object({
  key: text,
  title: text,
  align: optional(enumeration("left", "right")),
  grow: optional(bool),
  mono: optional(bool),
  priority: optional(number),
  minWidth: optional(number),
  optional: optional(bool),
  sortable: optional(bool),
  sortDesc: optional(bool),
});
const empty = object({
  title: text,
  description: optional(text),
  icon: optional(text),
});
const option = object({ value: text, label: text });
const environment = object({
  key: text,
  value: text,
  selected: bool,
  secret: bool,
});
const field: Schema = (v, p) => {
  const base = { id: text, label: text, description: optional(text) };
  switch ((v as any)?.type) {
    case "environment":
      object({
        ...base,
        type: literal("environment"),
        value: array(environment),
      })(v, p);
      break;
    case "select":
      object({
        ...base,
        type: literal("select"),
        value: text,
        options: array(option),
      })(v, p);
      break;
    case "switch":
      object({ ...base, type: literal("switch"), value: bool })(v, p);
      break;
    case "text":
      object({
        ...base,
        type: literal("text"),
        value: text,
        placeholder: optional(text),
        sensitive: optional(bool),
      })(v, p);
      break;
    default:
      fail(p);
  }
};
const filter = object({
  id: text,
  label: text,
  icon: optional(text),
  options: array(
    object({
      value: text,
      label: text,
      dot: optional(dot),
      count: optional(number),
    }),
  ),
  selected: array(text),
});
const dialog: Schema = (v, p) =>
  object({
    id: text,
    title: text,
    description: optional(text),
    children: array(node),
    actions,
    wide: optional(bool),
    resizable: optional(bool),
  })(v, p);
const node: Schema = (v, p) => {
  const base = { type: text };
  const children = array(node);
  const schemas: Record<string, Schema> = {
    stack: object({
      ...base,
      direction: optional(enumeration("row", "column")),
      gap: optional(number),
      children,
    }),
    page: object({
      ...base,
      search: optional(object({ placeholder: text })),
      actions,
      summary: optional(text),
      filters: optional(array(filter)),
      highlight: optional(array(text)),
      children,
      dialog: optional(dialog),
    }),
    table: object({
      ...base,
      id: text,
      columns: array(column),
      rows: array(row),
      actions,
      bulkActions: actions,
      empty: optional(empty),
      sort: optional(object({ key: text, desc: bool })),
    }),
    list: object({
      ...base,
      id: text,
      items: array(
        object({
          id: text,
          title: text,
          subtitle: optional(text),
          icon: optional(text),
          dot: optional(dot),
          meta: optional(text),
          metaAt: optional(timestamp),
          actions,
        }),
      ),
      empty: optional(empty),
    }),
    stats: object({
      ...base,
      items: array(
        object({
          label: text,
          value: text,
          at: optional(timestamp),
          hint: optional(text),
          tone: optional(tone),
        }),
      ),
    }),
    form: object({
      ...base,
      id: text,
      title: optional(text),
      description: optional(text),
      fields: array(field),
    }),
    empty: object({
      ...base,
      title: text,
      description: optional(text),
      icon: optional(text),
    }),
    text: object({ ...base, text, tone: optional(tone), mono: optional(bool) }),
    card: object({
      ...base,
      id: optional(text),
      title: optional(text),
      description: optional(text),
      tone: optional(tone),
      actions,
      children,
    }),
    details: object({
      ...base,
      items: array(
        object({
          label: text,
          value: text,
          mono: optional(bool),
          tone: optional(tone),
        }),
      ),
    }),
    log: object({
      ...base,
      id: text,
      lines: array(
        object({ text, at: optional(timestamp), tone: optional(tone) }),
      ),
      follow: optional(bool),
      empty: optional(text),
    }),
    terminal: object({
      ...base,
      id: text,
      lines: array(text),
      follow: optional(bool),
      empty: optional(text),
    }),
    conversation: object({
      ...base,
      id: text,
      messages: array(
        object({
          role: enumeration("user", "assistant", "tool", "system"),
          author: optional(text),
          text,
          at: optional(timestamp),
          tool: optional(object({ name: text, detail: optional(text) })),
        }),
      ),
      empty: optional(text),
    }),
    segmented: object({
      ...base,
      id: text,
      value: text,
      options: array(
        object({ value: text, label: text, icon: optional(text) }),
      ),
    }),
    progress: object({
      ...base,
      label: optional(text),
      value: optional((v, p) => {
        number(v, p);
        if ((v as number) < 0 || (v as number) > 1) fail(p);
      }),
      at: optional(timestamp),
      tone: optional(tone),
    }),
    markdown: object({ ...base, text }),
  };
  const schema = Object.hasOwn(schemas, (v as any)?.type)
    ? schemas[(v as any)?.type]
    : undefined;
  if (!schema) fail(`${p}.type`);
  schema!(v, p);
};
function bounded(value: unknown) {
  let count = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > LIMITS.depth || ++count > LIMITS.nodes)
      throw new Error("Protocol complexity limit");
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) walk(child, depth + 1);
    } else if (
      v !== null &&
      !["string", "boolean", "number"].includes(typeof v)
    )
      throw new Error("Non-JSON protocol value");
  };
  walk(value, 0);
}
export function validateTree(value: unknown): asserts value is Node {
  bounded(value);
  node(value, "tree");
}
export function validateMessage(
  value: unknown,
): asserts value is PluginMessage {
  bounded(value);
  const v = value as any;
  const schemas: Record<string, Schema> = {
    hello: object({
      type: literal("hello"),
      protocol: number,
      sdk: text,
      capabilities: array(text),
    }),
    ready: object({ type: literal("ready") }),
    prepared: object({
      type: literal("prepared"),
      requestId: text,
      ready: bool,
      reason: optional(text),
    }),
    render: object({ type: literal("render"), surface: text, tree: node }),
    badge: object({
      type: literal("badge"),
      value: union(text, number, literal(null)),
    }),
    toast: object({
      type: literal("toast"),
      text,
      tone: optional(enumeration("default", "success", "error")),
      action: optional(
        object({ id: text, label: text, payload: optional(any) }),
      ),
    }),
    clipboard: object({ type: literal("clipboard"), text }),
  };
  const schema = Object.hasOwn(schemas, v?.type) ? schemas[v?.type] : undefined;
  if (!schema) fail("message.type");
  schema!(value, "message");
}
export function validateEventPayload(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > 64 * 1024)
    throw new Error("Event payload limit");
  bounded(value ?? null);
}
