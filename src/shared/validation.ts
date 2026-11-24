import { LIMITS } from "./package";
import { MAX_SECTION_DEPTH, type Node, type PluginMessage } from "./protocol";

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
/** One key, or `alt+`/`shift+` (in that order) before a key or an arrow name. */
export const ACTION_KEY = /^(?:.|(?:alt\+(?:shift\+)?|shift\+)(?:[^+\s]|up|down|left|right))$/u;
/**
 * A toast button's shortcut: ⌘, optionally ⇧, and a letter. Letters the system or the host
 * already own with ⌘ (clipboard, select all, find, hide, minimize, close, quit) are refused.
 */
export const TOAST_KEY = /^cmd\+(?:shift\+)?(?![acfhmqvwx]$)[a-z]$/u;
const dotColor = union(color, literal("rainbow"));
const dot = union(
  dotColor,
  object({
    color: dotColor,
    label: optional(text),
    pulse: optional(bool),
    dim: optional(bool),
  }),
);
const actionFields = {
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
  key: optional((v: unknown, p: string) => {
    text(v, p);
    if (!ACTION_KEY.test(v as string)) fail(p);
  }),
  focus: optional(text),
  input: optional(object({ placeholder: optional(text) })),
};
/** A split button's alternatives: plain actions, one level deep. */
const alternative = object({
  ...actionFields,
  menu: (v, p) => {
    if (v !== undefined) fail(p);
  },
  checked: (v, p) => {
    if (v !== undefined) fail(p);
  },
});
const action: Schema = (v, p) => {
  object({ ...actionFields, menu: optional(array(alternative)) })(v, p);
  const a = v as { menu?: unknown[]; checked?: unknown };
  if (a.menu !== undefined && a.checked !== undefined) fail(`${p}.menu`);
};
const actions = optional(array(action));
/** A tag shade: 0 (lightest) to 1 (the full color). */
const shade: Schema = (v, p) => {
  number(v, p);
  if ((v as number) < 0 || (v as number) > 1) fail(p);
};
const tag = object({
  text,
  color: optional(color),
  icon: optional(text),
  tooltip: optional(text),
  shade: optional(shade),
});
const textStyle = object({ color: optional(color), bold: optional(bool), italic: optional(bool) });
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
    style: optional(textStyle),
    dot: optional(dot),
    strong: optional(text),
    prefix: optional(tag),
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
  target: optional(text),
  markdown: optional(bool),
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
      object({ label: text, value: text, description: optional(text), column: optional(text) }),
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
    context: optional(text),
    dot: optional(dot),
    targets: optional(record(array(target))),
    unread: optional(bool),
    pane: optional(array(node)),
  })(v, p);
const pixels: Schema = (v, p) => {
  number(v, p);
  if ((v as number) < 0 || (v as number) > 100_000) fail(p);
};
const column = object({
  key: text,
  title: text,
  align: optional(enumeration("left", "right")),
  grow: optional(union(bool, pixels)),
  shrink: optional(pixels),
  mono: optional(bool),
  width: optional(union(pixels, literal("content"))),
  priority: optional(number),
  minWidth: optional(pixels),
  maxWidth: optional(pixels),
  optional: optional(bool),
  resizable: optional(bool),
  reorderable: optional(bool),
  sortable: optional(bool),
  sortDesc: optional(bool),
});
const sectionFields = {
  id: text,
  label: text,
  icon: optional(text),
  empty: optional(text),
  collapsed: optional(bool),
  muted: optional(bool),
  order: optional(enumeration("manual", "fixed", false)),
  dropLabel: optional(text),
  dropIcon: optional(text),
  pill: optional(object({ color: optional(color), shade: optional(shade) })),
};
/** Nested sections (`Section.sections`) go at most `MAX_SECTION_DEPTH` levels deep, counting the top. */
const sectionAt = (depth: number): Schema => (v, p) => {
  if (depth > MAX_SECTION_DEPTH) fail(p);
  object({ ...sectionFields, sections: optional(array(sectionAt(depth + 1))) })(v, p);
};
/** A table's sections: every section id appears once, at whatever depth. */
const sections: Schema = (v, p) => {
  array(sectionAt(1))(v, p);
  const seen = new Set<string>();
  const visit = (list: { id: string; sections?: { id: string }[] }[], at: string) =>
    list.forEach((s, i) => {
      if (seen.has(s.id)) fail(`${at}[${i}].id`);
      seen.add(s.id);
      if (s.sections) visit(s.sections, `${at}[${i}].sections`);
    });
  visit(v as { id: string }[], p);
};
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
const count: Schema = (v, p) => {
  number(v, p);
  if (!Number.isInteger(v) || (v as number) < 0) fail(p);
};
const rowCount: Schema = (v, p) => {
  number(v, p);
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 40) fail(p);
};
/** "" (no date), a real local date, or a date and time. */
const localDateTime: Schema = (v, p) => {
  text(v, p);
  if (v === "") return;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/.exec(v as string);
  if (!m) fail(p);
  const [y, mo, d] = [Number(m![1]), Number(m![2]), Number(m![3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) fail(p);
};
const field: Schema = (v, p) => {
  const base = { id: text, label: text, description: optional(text), autofocus: optional(bool) };
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
        heading: optional(bool),
        note: optional(text),
      })(v, p);
      break;
    case "textarea":
      object({
        ...base,
        type: literal("textarea"),
        value: text,
        placeholder: optional(text),
        markdown: optional(bool),
        rows: optional(rowCount),
      })(v, p);
      break;
    case "datetime":
      object({
        ...base,
        type: literal("datetime"),
        value: localDateTime,
        time: optional(bool),
        placeholder: optional(text),
        presets: optional(array(object({ label: text, value: localDateTime }))),
      })(v, p);
      if ((v as any).time === false && (v as any).value.includes("T")) fail(`${p}.value`);
      ((v as any).presets ?? []).forEach((x: { value: string }, i: number) => {
        if (x.value === "" || ((v as any).time === false && x.value.includes("T"))) fail(`${p}.presets[${i}].value`);
      });
      break;
    case "color":
      object({ ...base, type: literal("color"), value: hue })(v, p);
      break;
    case "combobox":
      object({
        ...base,
        type: literal("combobox"),
        value: text,
        options: array(object({ value: text, label: text, sub: optional(text) })),
        freeform: optional(bool),
        placeholder: optional(text),
      })(v, p);
      break;
    case "tags": {
      object({
        ...base,
        type: literal("tags"),
        value: array(object({ key: text, value: optional(text) })),
        keys: array(
          object({
            key: text,
            label: text,
            color: optional(color),
            values: optional(array(text)),
            freeform: optional(bool),
            flag: optional(bool),
            shades: optional(record(shade)),
            colors: optional(record(hue)),
            multiple: optional(bool),
          }),
        ),
      })(v, p);
      const keys = (v as any).keys.map((k: { key: string }) => k.key);
      if (new Set(keys).size !== keys.length) fail(`${p}.keys`);
      // A key appears once, unless it's `multiple` (then once per value).
      const multiple = new Set((v as any).keys.filter((k: { multiple?: boolean }) => k.multiple).map((k: { key: string }) => k.key));
      const used = (v as any).value.map((t: { key: string; value?: string }) => (multiple.has(t.key) ? `${t.key}\u0000${t.value ?? ""}` : t.key));
      if (new Set(used).size !== used.length || (v as any).value.some((t: { key: string }) => !keys.includes(t.key))) fail(`${p}.value`);
      break;
    }
    case "options": {
      object({
        ...base,
        type: literal("options"),
        value: array(object({ key: optional(text), text, color: optional(hue), count: optional(count) })),
        colors: optional(bool),
        reorder: optional(bool),
        placeholder: optional(text),
      })(v, p);
      const keys = (v as any).value.flatMap((o: { key?: string }) => (o.key === undefined ? [] : [o.key]));
      if (new Set(keys).size !== keys.length) fail(`${p}.value`);
      break;
    }
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
  group: optional(bool),
  groupDisabled: optional(text),
  default: optional(object({ values: array(text), label: text })),
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
const segmented = object({
  type: literal("segmented"), id: text, value: text, label: optional(text),
  options: array(object({ value: text, label: text, icon: optional(text), tooltip: optional(text) })),
});
const choice = object({
  type: literal("choice"), id: text, value: text, label: text, icon: optional(text),
  options: array(object({ value: text, label: text, description: optional(text), section: optional(text) })),
});
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
      controls: optional(array(union(segmented, choice))),
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
      overflow: optional(enumeration("hide", "scroll")),
      layoutVersion: optional(number),
      sections: optional(sections),
      reorder: optional(bool),
      reorderOnto: optional(text),
      contextSelect: optional(bool),
      paneButtons: optional(bool),
      selectEvents: optional(bool),
      enter: optional(text),
      appearance: optional(enumeration("grid", "document")),
    }),
    list: object({
      ...base,
      id: text,
      items: array(
        object({
          id: text,
          title: text,
          titleStyle: optional(textStyle),
          subtitle: optional(text),
          icon: optional(text),
          dot: optional(dot),
          meta: optional(text),
          metaAt: optional(timestamp),
          actions,
          unread: optional(bool),
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
      appearance: optional(literal("inline")),
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
    timeline: (v, p) => {
      object({
        ...base,
        id: text,
        entries: array(
          object({
            id: text,
            at: timestamp,
            text,
            edited: optional(timestamp),
            author: optional(text),
            title: optional(text),
            actions: optional(array(text)),
          }),
        ),
        actions,
        selected: optional(text),
        empty: optional(empty),
        edit: optional(action),
      })(v, p);
      const ids = (v as any).entries.map((e: { id: string }) => e.id);
      if (new Set(ids).size !== ids.length) fail(`${p}.entries`);
    },
    composer: object({
      ...base,
      id: text,
      action,
      placeholder: optional(text),
      single: optional(bool),
      key: optional((v: unknown, p: string) => {
        text(v, p);
        if (!/^[a-z0-9]$/.test(v as string)) fail(p);
      }),
    }),
    segmented,
    choice,
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
    if (depth > LIMITS.depth)
      throw new Error(`Protocol complexity limit: nested deeper than ${LIMITS.depth} levels`);
    if (++count > LIMITS.nodes)
      throw new Error(`Protocol complexity limit: more than ${LIMITS.nodes} values`);
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
        object({
          id: text,
          label: text,
          payload: optional(any),
          key: optional((v: unknown, p: string) => {
            text(v, p);
            if (!TOAST_KEY.test(v as string)) fail(p);
          }),
        }),
      ),
    }),
    clipboard: object({ type: literal("clipboard"), text }),
    navigate: object({
      type: literal("navigate"),
      screen: text,
      select: optional(text),
    }),
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

/** Why a plugin message was refused, short enough for the plugin's crash screen. Field paths can
 *  contain plugin-chosen keys, so the reason is capped. */
export function protocolReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
}
