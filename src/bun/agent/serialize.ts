// Plugin trees as agents read them (docs/agent-interface.md): compact text, or the tree as JSON, both
// with sensitive values masked and long tables paged. Pure: no host state.
import type { Action, Cell, Dot, Field, GroupLabel, Node, Row, Section, Tag } from "../../shared/protocol";

export const MASK = "••••••";

export type ReadOptions = {
	/** Rows per table (top-level rows; children come with their parent). Default 100. */
	maxRows?: number;
	/** Only this table is paged by `offset`; others start at their first row. */
	table?: string;
	offset?: number;
	/** Include rows' inspector details. Default true. */
	details?: boolean;
	now?: number;
};

const MAX_TEXT = 60_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

/** A deep copy with sensitive field values and secret environment values masked. */
export function redact<T>(value: T): T {
	if (Array.isArray(value)) return value.map(redact) as T;
	if (!value || typeof value !== "object") return value;
	const o = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) out[k] = redact(v);
	if (o.type === "text" && o.sensitive === true && typeof o.value === "string" && o.value) out.value = MASK;
	if (o.type === "environment" && Array.isArray(o.value))
		out.value = (o.value as { secret?: boolean; value?: string }[]).map((e) =>
			e && e.secret ? { ...e, value: MASK } : e,
		);
	return out as T;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "2026-11-24 21:30 (in 2h 14m)": absolute local time plus relative, as the UI shows it. */
export function when(at: number, now = Date.now()) {
	const d = new Date(at);
	const abs = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const diff = Math.round((at - now) / 60_000);
	const m = Math.abs(diff);
	const span = m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60) ? ` ${Math.floor((m % 1440) / 60)}h` : ""}`;
	return `${abs} (${span === "now" ? "now" : diff > 0 ? `in ${span}` : `${span} ago`})`;
}

/** One line: line breaks in a value become " / ", so every value stays on its own line and indentation. */
export const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " / ");

const dotText = (dot?: Dot) => (dot && typeof dot === "object" && dot.label ? dot.label : "");
const tagsText = (tags?: Tag[]) => (tags?.length ? `[${tags.map((t) => oneLine(t.text)).join(", ")}]` : "");

/** A cell's text. `withDot`: lead with its status dot's label. */
export function cellText(cell: Cell | undefined, now: number, withDot = true): string {
	if (cell === null || cell === undefined) return "";
	if (typeof cell !== "object") return oneLine(String(cell));
	const parts: string[] = [];
	const status = withDot ? dotText(cell.dot) : "";
	if (status) parts.push(`(${status})`);
	if (cell.prefix) parts.push(`[${cell.prefix.text}]`);
	parts.push(cell.at !== undefined ? when(cell.at, now) : oneLine(cell.text));
	if (cell.marks?.length) parts.push(`{${cell.marks.map((m) => m.tooltip).join("; ")}}`);
	if (cell.chips?.length) parts.push(`<${cell.chips.join(", ")}>`);
	const second = [tagsText(cell.tags), oneLine(cell.sub ?? "")].filter(Boolean).join(" ");
	if (second) parts.push(`— ${second}`);
	return parts.filter(Boolean).join(" ");
}

const labelOf = (g: GroupLabel) => (typeof g === "string" ? g : g.label + (g.sub ? ` (${g.sub})` : ""));
const idOf = (g: GroupLabel) => (typeof g === "string" ? g : (g.id ?? g.label));

function fieldText(f: Field, now: number): string {
	switch (f.type) {
		case "text":
			return f.sensitive && f.value ? MASK : f.value;
		case "textarea":
			return clip(f.value, 2000);
		case "select":
		case "combobox":
			return f.options.find((o) => o.value === f.value)?.label ?? f.value;
		case "switch":
			return f.value ? "on" : "off";
		case "datetime":
			return f.value || (f.placeholder ?? "none");
		case "color":
			return f.value;
		case "tags":
			return f.value.map((t) => {
				const label = f.keys.find((k) => k.key === t.key)?.label ?? t.key;
				return t.value === undefined ? label : `${label}: ${t.value}`;
			}).join(", ") || "none";
		case "options":
			return f.value.map((o) => o.text).join(", ") || "none";
		case "duration":
			return f.value === null ? (f.none ?? "none") : `${f.value} min`;
		case "environment":
			return f.value.map((e) => `${e.key}=${e.secret ? MASK : e.value}${e.selected ? "" : " (off)"}`).join(", ") || "none";
	}
	void now;
	return "";
}

/** Enabled actions' labels, each once (plugins often offer variants under one label). */
const actionLabels = (actions?: Action[]) => [
	...new Set((actions ?? []).filter((a) => !a.disabled).map((a) => a.label + (a.menu?.length ? ` (or: ${a.menu.map((m) => m.label).join(", ")})` : ""))),
];

type Out = { lines: string[]; notes: string[] };

type WalkOptions = Required<Omit<ReadOptions, "table">> & { table?: string };

/** Labels of the row's own actions when they differ from the table's (`Row.actions` names a subset). */
function ownActions(row: Row, actions: Action[] | undefined) {
	if (!row.actions || !actions?.length) return null;
	const all = actionLabels(actions);
	const mine = actionLabels(actions.filter((a) => row.actions!.includes(a.id)));
	return mine.length === all.length ? null : mine;
}

type Columns = { key: string; title?: string }[];

function rowLines(row: Row, cols: Columns, depth: number, opts: WalkOptions, out: Out, actions?: Action[]) {
	const columns = cols.map((c) => c.key);
	const indent = "  ".repeat(depth);
	// A status dot's label is left out when another cell already says it.
	const plain = columns.map((k) => cellText(row.cells[k], opts.now, false));
	const cells = columns
		.map((k, i) => {
			const cell = row.cells[k];
			const label = cell && typeof cell === "object" ? dotText(cell.dot) : "";
			return label && !plain.some((p) => p.includes(label)) ? `(${label}) ${plain[i]}` : plain[i];
		})
		.filter(Boolean);
	const rowDot = dotText(row.dot);
	const flags = [row.unread ? "unread" : "", row.context ? `context for ${row.context}` : "", rowDot && !plain.some((p) => p.includes(rowDot)) ? rowDot : ""].filter(Boolean);
	const own = ownActions(row, actions);
	out.lines.push(`${indent}- ${cells.join(" · ")}  {id: ${row.id}}${flags.length ? ` [${flags.join(", ")}]` : ""}${own ? ` (actions: ${own.length ? own.join(", ") : "none"})` : ""}`);
	if (opts.details) {
		// A stat or detail that repeats the row line's cell of the same name is left out.
		const shown = (label: string, value: string) =>
			cols.some((c, i) => (c.title ?? c.key).toLowerCase() === label.toLowerCase() && plain[i] === oneLine(value).trim());
		for (const s of row.stats ?? []) if (!shown(s.label, String(s.value))) out.lines.push(`${indent}    ${s.label}: ${oneLine(String(s.value))}`);
		for (const d of row.details ?? []) if (!shown(d.label, d.value)) out.lines.push(`${indent}    ${d.section && d.section !== d.label ? `${d.section} › ` : ""}${d.label}: ${oneLine(clip(d.value, 500))}`);
		// The details drawer (`pane`): forms, timelines and cards about this row.
		if (row.pane?.length) {
			const pane: Out = { lines: [], notes: [] };
			for (const node of row.pane) walk(node, { ...opts, maxRows: Math.min(opts.maxRows, 20) }, pane);
			for (const line of pane.lines) for (const part of line.split("\n")) if (part) out.lines.push(`${indent}    ${part.replace(/^#+ /, "")}`);
		}
	}
	for (const child of row.children ?? []) rowLines(child, cols, depth + 1, opts, out, actions);
}

/** Declared sections and sub-sections by id: their labels and ids from the top level down. */
function sectionPaths(sections: Section[] | undefined, parent: { labels: string[]; ids: string[] } = { labels: [], ids: [] }, map = new Map<string, { labels: string[]; ids: string[] }>()) {
	for (const s of sections ?? []) {
		const path = { labels: [...parent.labels, s.label], ids: [...parent.ids, s.id] };
		map.set(s.id, path);
		sectionPaths(s.sections, path, map);
	}
	return map;
}

function walk(node: Node, opts: WalkOptions, out: Out) {
	const { now } = opts;
	switch (node.type) {
		case "page": {
			if (node.summary) out.lines.push(`Summary: ${node.summary}`);
			for (const f of node.filters ?? []) {
				const picked = f.options.filter((o) => f.selected.includes(o.value)).map((o) => o.label);
				// A filter at its declared default ("Ongoing") isn't something the person set.
				const atDefault = !!f.default && f.default.values.length === f.selected.length && f.default.values.every((v) => f.selected.includes(v));
				out.lines.push(`Filter ${f.label}: ${atDefault ? `${f.default!.label} (default: ${picked.join(", ")})` : picked.length ? picked.join(", ") : "all"}${f.options.length ? ` (options: ${f.options.map((o) => `${o.label}${o.count !== undefined ? ` ${o.count}` : ""}`).join(", ")})` : ""}`);
				if (picked.length && !atDefault) out.notes.push(`filter "${f.label}" = ${picked.join(", ")}`);
			}
			for (const c of node.controls ?? []) walk(c, opts, out);
			if (node.highlight?.length) {
				out.lines.push(`Search: ${node.highlight.join(" ")}`);
				out.notes.push(`search "${node.highlight.join(" ")}"`);
			}
			const toolbar = actionLabels(node.actions);
			if (toolbar.length) out.lines.push(`Toolbar actions: ${toolbar.join(", ")}`);
			for (const child of node.children) walk(child, opts, out);
			if (node.dialog) {
				out.lines.push("", `## Dialog open: ${node.dialog.title}${node.dialog.description ? ` — ${node.dialog.description}` : ""}`);
				out.notes.push(`dialog "${node.dialog.title}" open`);
				for (const child of node.dialog.children) walk(child, opts, out);
			}
			return;
		}
		case "stack":
			for (const child of node.children) walk(child, opts, out);
			return;
		case "table": {
			const total = node.rows.length;
			const offset = opts.table === node.id ? Math.max(0, opts.offset) : 0;
			const rows = node.rows.slice(offset, offset + opts.maxRows);
			const sortCol = node.sort && node.columns.find((c) => c.key === node.sort!.key);
			out.lines.push("", `## Table ${node.id}: ${total} row${total === 1 ? "" : "s"}${sortCol ? `, sorted by ${sortCol.title}${node.sort!.desc ? " (descending)" : ""}` : ""}`);
			if (!total) {
				if (node.empty) out.lines.push(`(empty: ${node.empty.title}${node.empty.description ? ` — ${node.empty.description}` : ""})`);
			} else {
				out.lines.push(`Columns: ${node.columns.map((c) => c.title || c.key).join(" · ")}`);
			}
			const rowActions = actionLabels(node.actions);
			if (rowActions.length) out.lines.push(`Row actions: ${rowActions.join(", ")}${node.rows.some((r) => ownActions(r, node.actions)) ? " (a row that allows fewer lists its own)" : ""}`);
			const bulk = actionLabels(node.bulkActions);
			if (bulk.length) out.lines.push(`Bulk actions: ${bulk.join(", ")}`);
			const sections = sectionPaths(node.sections);
			const used = new Set<string>();
			let header = "";
			for (const row of rows) {
				const path = row.group === undefined ? [] : typeof row.group === "string" ? [row.group] : row.group;
				// A row in a sub-section sits under its parent sections too.
				const declared = path.length ? sections.get(idOf(path[0])) : undefined;
				for (const id of declared?.ids ?? []) used.add(id);
				for (const g of path) used.add(idOf(g));
				// A sub-section named like its parent ("Progressing › Progressing") is said once.
				const h = [...(declared?.labels ?? []), ...path.slice(declared ? 1 : 0).map((g) => sections.get(idOf(g))?.labels.at(-1) ?? labelOf(g))]
					.filter((label, i, all) => label !== all[i - 1])
					.join(" › ");
				if (h !== header) {
					header = h;
					if (h) out.lines.push(`### ${h}`);
				}
				rowLines(row, node.columns, 0, opts, out, node.actions);
			}
			// Empty sections are only known when every row was looked at.
			const empty = [...sections].filter(([id]) => !used.has(id)).map(([, p]) => p.labels.filter((l, i, all) => l !== all[i - 1]).join(" › "));
			if (empty.length && offset === 0 && rows.length === total) out.lines.push(`Empty sections: ${empty.join(", ")}`);
			if (total && offset >= total) out.lines.push(`(offset ${offset} is past the end: the table has ${total} row${total === 1 ? "" : "s"}; offsets start at 0)`);
			else if (total && !rows.length) out.lines.push(`(${total} row${total === 1 ? "" : "s"} not listed: max_rows is 0)`);
			else if (offset + rows.length < total)
				out.lines.push(`(showing rows ${offset + 1}–${offset + rows.length} of ${total}; read again with table "${node.id}" and offset ${offset + rows.length} for more)`);
			return;
		}
		case "list": {
			out.lines.push("", `## List: ${node.items.length} item${node.items.length === 1 ? "" : "s"}`);
			if (!node.items.length && node.empty) out.lines.push(`(empty: ${node.empty.title})`);
			for (const item of node.items.slice(0, opts.maxRows)) {
				const meta = item.metaAt !== undefined ? when(item.metaAt, now) : item.meta;
				out.lines.push(`- ${item.prefix ? `[${item.prefix.text}] ` : ""}${oneLine(item.title)}${item.subtitle ? ` — ${oneLine(item.subtitle)}` : ""}${meta ? ` · ${oneLine(meta)}` : ""}${item.tags?.length ? ` ${tagsText(item.tags)}` : ""}  {id: ${item.id}}${item.unread ? " [unread]" : ""}`);
			}
			if (node.items.length > opts.maxRows) out.lines.push(opts.maxRows ? `(showing ${opts.maxRows} of ${node.items.length})` : `(${node.items.length} items not listed: max_rows is 0)`);
			return;
		}
		case "stats":
			out.lines.push(node.items.map((i) => `${i.label}: ${i.at !== undefined ? when(i.at, now) : oneLine(String(i.value))}${i.hint ? ` (${oneLine(i.hint)})` : ""}`).join(" · "));
			return;
		case "form":
			// Ids are the plugin's internals: a form or field without a label is shown without one.
			out.lines.push("", `## Form${node.title ? `: ${node.title}` : ""}${node.description ? ` — ${node.description}` : ""}`);
			for (const f of node.fields) out.lines.push(`- ${f.label ? `${oneLine(f.label)}: ` : ""}${oneLine(fieldText(f, now))}`);
			return;
		case "empty":
			out.lines.push(`(empty: ${node.title}${node.description ? ` — ${node.description}` : ""})`);
			return;
		case "text":
			out.lines.push(node.text);
			return;
		case "card": {
			out.lines.push("", `## ${node.title ?? "Card"}${node.description ? ` — ${node.description}` : ""}`);
			const acts = actionLabels(node.actions);
			for (const child of node.children) walk(child, opts, out);
			if (acts.length) out.lines.push(`Actions: ${acts.join(", ")}`);
			return;
		}
		case "details":
			for (const i of node.items) out.lines.push(`- ${i.label ? `${i.label}: ` : ""}${oneLine(clip(i.value, 1000))}`);
			return;
		case "log":
		case "terminal": {
			const lines = node.lines.map((l) => (typeof l === "string" ? l : `${l.at !== undefined ? `${when(l.at, now)} ` : ""}${l.text}`));
			const tail = lines.slice(-40);
			out.lines.push("", `## ${node.type === "log" ? "Log" : "Terminal"}${lines.length > tail.length ? ` (last ${tail.length} of ${lines.length} lines)` : ""}`);
			if (!lines.length && node.empty) out.lines.push(`(empty: ${node.empty})`);
			for (const l of tail) out.lines.push(`  ${oneLine(clip(l, 400))}`);
			return;
		}
		case "conversation": {
			const tail = node.messages.slice(-20);
			out.lines.push("", `## Conversation${node.messages.length > tail.length ? ` (last ${tail.length} of ${node.messages.length} messages)` : ""}`);
			for (const m of tail) out.lines.push(`- ${m.author ?? m.role}${m.at ? ` (${when(m.at, now)})` : ""}: ${oneLine(clip(m.tool ? `[${m.tool.name}] ${m.text}` : m.text, 600))}`);
			return;
		}
		case "timeline":
			out.lines.push("", `## Timeline: ${node.entries.length} entr${node.entries.length === 1 ? "y" : "ies"}`);
			if (!node.entries.length && node.empty) out.lines.push(`(empty: ${node.empty.title})`);
			for (const e of node.entries.slice(0, opts.maxRows))
				out.lines.push(`- ${when(e.at, now)}${e.author ? ` · ${oneLine(e.author)}` : ""}${e.title ? ` · ${oneLine(e.title)}` : ""}: ${oneLine(clip(e.text, 600))}`);
			if (node.entries.length > opts.maxRows) out.lines.push(`(showing ${opts.maxRows} of ${node.entries.length})`);
			return;
		case "composer":
			return;
		case "segmented":
		case "choice": {
			const picked = node.options.find((o) => o.value === node.value)?.label ?? node.value;
			out.lines.push(`Control ${node.label ?? node.id}: ${picked} (options: ${node.options.map((o) => o.label).join(", ")})`);
			return;
		}
		case "progress":
			out.lines.push(`Progress${node.label ? ` ${node.label}` : ""}: ${node.value === undefined ? "working…" : `${Math.round(node.value * 100)}%`}`);
			return;
		case "markdown":
			out.lines.push(clip(node.text, 4000));
			return;
	}
}

/** A surface as text, plus notes on shared view state (search, filters, dialog) it reflects. */
export function treeText(tree: Node, options: ReadOptions = {}) {
	const out: Out = { lines: [], notes: [] };
	walk(redact(tree), {
		maxRows: options.maxRows ?? 100,
		offset: options.offset ?? 0,
		details: options.details ?? true,
		now: options.now ?? Date.now(),
		table: options.table,
	}, out);
	while (out.lines[0] === "") out.lines.shift();
	let text = out.lines.join("\n");
	if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n(truncated at ${MAX_TEXT} characters; read one table at a time with a smaller max_rows)`;
	return { text, viewState: out.notes };
}

/** Protocol fields that hold epoch-millisecond times: JSON gets an ISO 8601 copy beside each (`atIso`). */
const TIME_KEYS = ["at", "metaAt", "edited"];
/** Row fields that are the row's inspector details, left out with `details: false`. */
const DETAIL_KEYS = ["details", "stats", "pane"];

/** A surface as redacted JSON, tables cut to `maxRows` rows (from `offset` for `table`). */
export function treeJson(tree: Node, options: ReadOptions = {}): Node {
	const maxRows = options.maxRows ?? 100;
	const details = options.details ?? true;
	const cut = (value: unknown, row = false): unknown => {
		if (Array.isArray(value)) return value.map((v) => cut(v, row));
		if (!value || typeof value !== "object") return value;
		const o: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (row && !details && DETAIL_KEYS.includes(k)) continue;
			// Rows (and their children) are the objects under a table's `rows`.
			o[k] = cut(v, k === "rows" || (row && k === "children"));
			if (TIME_KEYS.includes(k) && typeof v === "number") o[`${k}Iso`] = new Date(v).toISOString();
		}
		if (o.type === "table" && Array.isArray(o.rows)) {
			const offset = options.table === o.id ? Math.max(0, options.offset ?? 0) : 0;
			const total = o.rows.length;
			o.rows = o.rows.slice(offset, offset + maxRows);
			if (offset || total > offset + maxRows) o.paging = { offset, total };
		}
		return o;
	};
	return cut(redact(tree)) as Node;
}
