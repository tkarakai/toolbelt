// Plugin trees as agents read them (docs/agent-interface.md): compact text, or the tree as JSON, both
// with sensitive values masked and long tables paged. Pure: no host state.
import type { Action, Cell, Dot, Field, GroupLabel, Node, Row, Section, Tag } from "../../shared/protocol";
import { labelled } from "./names";

export const MASK = "••••••";

export type ReadOptions = {
	/** Rows per table, child rows included (the last parent may lose some children). Default 50. */
	maxRows?: number;
	/** Only this table is paged by `offset`; others start at their first row. */
	table?: string;
	offset?: number;
	/** Include rows' inspector details (details, stats, drawer) and their own action lists. Default false. */
	details?: boolean;
	now?: number;
	/** The result's size limit in characters; tables stop at a row boundary to stay under it. */
	budget?: number;
	/** With `table`: page the children of this row (any depth) instead of the table's top-level rows. */
	parent?: string;
	/** Hints name a resource URI to read next instead of read_screen options (a resource read). */
	resource?: string;
	/** Filter ids the reader chose: not pointed out as hiding rows. */
	chosen?: string[];
};

/** A filter's options a read leaves out (its unchecked options with rows), for `search_screens`. */
export type Hidden = { id: string; label: string; options: { value: string; label: string; count?: number }[] };

export const DEFAULT_ROWS = 50;
/** Size limits for agent results, in characters (MCP clients keep tool results small). */
export const TEXT_BUDGET = 50_000;
export const JSON_BUDGET = 100_000;
/** Room kept under the text budget for the notes that say where to read on, so the final cut never drops them. */
const HINT_ROOM = 600;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

/**
 * Secrets that commonly appear in plugin text a plugin didn't mark sensitive, such as command
 * lines and URLs: each pattern's last group is masked, the rest (the flag or variable name) kept.
 */
const SECRET_NAME = String.raw`[\w-]*(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|access[-_]?key|private[-_]?key|credentials?)[\w-]*`;
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"']+)`;
const SECRET_PATTERNS: RegExp[] = [
	// --token=…, --api-key …, -password …
	new RegExp(String.raw`(\s-{1,2}${SECRET_NAME}(?:=|\s+))(?!-)${VALUE}`, "gi"),
	new RegExp(String.raw`(^-{1,2}${SECRET_NAME}(?:=|\s+))(?!-)${VALUE}`, "gi"),
	// GITHUB_TOKEN=…, export AWS_SECRET_ACCESS_KEY=…
	new RegExp(String.raw`(\b${SECRET_NAME}=)("[^"]*"|'[^']*'|[^\s"'&;,]+)`, "gi"),
	// "api_key": "…" (JSON), password: … (only a password-like name, so "Tokens: 1200" stays)
	new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*")([^"]+)(?=")`, "gi"),
	/(\b(?:passw(?:or)?d|passphrase)\s*:\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
	// ?token=…&, &signature=…
	/([?&](?:[\w-]*(?:token|key|secret|password|sig|signature|auth)[\w-]*)=)([^&\s#"']+)/gi,
	// Authorization: Bearer …, Bearer …
	/(\bauthorization:\s*(?:bearer|basic|token)?\s*)([^\s"']+)/gi,
	/(\bbearer\s+)([a-z0-9._~+/=-]{8,})/gi,
	// user:password@host in URLs
	/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@/]+)(?=@)/gi,
	// Well-known token formats, wherever they appear.
	/()(\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}))/g,
];

/** Plugin text with likely secrets (tokens, passwords, keys in command lines and URLs) masked. */
export function maskSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (_m, keep: string) => `${keep}${MASK}`);
	return out;
}

/**
 * A deep copy with sensitive field values and secret environment values masked, and likely
 * secrets in any other text masked too.
 */
export function redact<T>(value: T): T {
	if (Array.isArray(value)) return value.map(redact) as T;
	if (typeof value === "string") return maskSecrets(value) as T;
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

/**
 * One line: line breaks in a value become " ⏎ ", so every value stays on its own line and
 * indentation. (Not "/": commands and paths are full of slashes.)
 */
export const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ⏎ ");

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

/** A tags field's values as they read: "Project: Houses", or a flag's label alone. */
function tagLabels(f: Extract<Field, { type: "tags" }>) {
	return f.value.map((t) => {
		const label = f.keys.find((k) => k.key === t.key)?.label ?? t.key;
		return t.value === undefined ? label : `${label}: ${t.value}`;
	});
}

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
			return tagLabels(f).join(", ") || "none";
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

/** A field with nothing in it: in a row's drawer it says nothing, so it is left out. */
function emptyField(f: Field): boolean {
	switch (f.type) {
		case "tags":
		case "options":
		case "environment":
			return !f.value.length;
		case "duration":
			return f.value === null;
		case "switch":
			return false;
		default:
			return !String(f.value ?? "").trim();
	}
}

/** Enabled actions' labels, each once (plugins often offer variants under one label). */
const actionLabels = (actions?: Action[]) => [
	...new Set((actions ?? []).filter((a) => !a.disabled).map((a) => a.label + (a.menu?.length ? ` (or: ${a.menu.map((m) => m.label).join(", ")})` : ""))),
];

type Out = {
	lines: string[];
	notes: string[];
	/** Filters hiding rows, on the page. */
	hidden?: Hidden[];
	/** Characters in `lines` up to `counted`. */
	size?: number;
	counted?: number;
	/** Table rows listed so far: the first always comes, whatever its size. */
	rowsShown?: number;
};
/** Characters so far (lines plus line breaks), counted incrementally. */
function sizeOf(out: Out) {
	out.size ??= 0;
	out.counted ??= 0;
	for (; out.counted < out.lines.length; out.counted++) out.size += out.lines[out.counted].length + 1;
	return out.size;
}

type WalkOptions = Required<Omit<ReadOptions, "table" | "parent" | "resource" | "chosen">> & {
	chosen?: string[];
	table?: string;
	parent?: string;
	resource?: string;
	/**
	 * Set inside a row's drawer: values the row line or its section headings already show (its
	 * first cell's text, cell subtitles, section labels). A drawer value equal to one of them, an
	 * empty field and an empty timeline or list are left out.
	 */
	drawer?: Set<string>;
};
/** How to read on from `next`: read_screen options, or for a resource read, the URI to read. */
function resume(opts: WalkOptions, table: string, next: number, parent?: string) {
	if (opts.resource) {
		const q = new URLSearchParams({ table, ...(parent ? { parent } : {}), offset: String(next) });
		return `read ${opts.resource}${opts.resource.includes("?") ? "&" : "?"}${q}`;
	}
	return `read again with table "${table}"${parent ? `, parent "${parent}"` : ""} and offset ${next}`;
}
const detailsOff = (opts: WalkOptions) => (opts.resource ? "add details=false" : "pass details: false");
const detailsOn = (opts: WalkOptions) => (opts.resource ? "add details=true" : "pass details: true");
/** Whether any row (at any depth) has inspector content that `details: false` leaves out. */
const hasDetails = (rows: Row[]): boolean => rows.some((r) => !!(r.details?.length || r.stats?.length || r.pane?.length) || hasDetails(r.children ?? []));
/** A value as the drawer comparison sees it: on one line, trimmed. */
const norm = (s: string) => oneLine(s).trim();
/** Whether the previous line is a heading with nothing under it yet: a timeline or list there doesn't add its own. */
const underHeading = (out: Out) => /^## /.test(out.lines.at(-1) ?? "");
/** A row anywhere under `rows`, by id. */
export function findRow(rows: Row[], id: string): Row | undefined {
	for (const r of rows) {
		if (r.id === id) return r;
		const found = r.children?.length ? findRow(r.children, id) : undefined;
		if (found) return found;
	}
	return undefined;
}

/** Labels of the row's own actions when they differ from the table's (`Row.actions` names a subset). */
function ownActions(row: Row, actions: Action[] | undefined) {
	if (!row.actions || !actions?.length) return null;
	const all = actionLabels(actions);
	const mine = actionLabels(actions.filter((a) => row.actions!.includes(a.id)));
	return mine.length === all.length ? null : mine;
}

/** A row as paged for an agent: children may be cut, `omittedChildren` counts the rows left out under it. */
export type PagedRow = Row & { omittedChildren?: number };
const countRows = (rows: Row[] = []): number => rows.reduce((n, r) => n + 1 + countRows(r.children), 0);

/**
 * One page of a table's rows from `offset`: at most `maxRows` rows counting children, whole
 * top-level rows only, except that the first row always comes (with as many children as fit).
 * `next` is the offset of the first top-level row left out.
 */
export function pageRows(all: Row[], offset: number, maxRows: number): { rows: PagedRow[]; next: number | null } {
	let left = maxRows;
	const prune = (row: Row): PagedRow => {
		left--;
		if (!row.children?.length) return row;
		const kids: PagedRow[] = [];
		for (const child of row.children) {
			if (left <= 0) break;
			kids.push(prune(child));
		}
		const omitted = countRows(row.children) - countRows(kids) + kids.reduce((n, k) => n + (k.omittedChildren ?? 0), 0);
		return omitted ? { ...row, children: kids, omittedChildren: omitted } : { ...row, children: kids };
	};
	const rows: PagedRow[] = [];
	let i = Math.max(0, offset);
	// A top-level row comes whole when it fits; only the first may be cut to fit at all.
	for (; i < all.length && left > 0; i++) {
		const size = 1 + countRows(all[i].children);
		if (rows.length && size > left) break;
		rows.push(prune(all[i]));
	}
	return { rows, next: i < all.length ? i : null };
}

type Columns = { key: string; title?: string }[];

/** What rowLines needs about the table and the row's parent. */
type RowContext = {
	table: string;
	actions?: Action[];
	/** The parent row's cell texts: a child's detail repeating one is left out. */
	parentCells: string[];
	/** The labels of the section headings the row is under. */
	sections: string[];
};

function rowLines(row: Row, cols: Columns, depth: number, opts: WalkOptions, out: Out, ctx: RowContext) {
	const actions = ctx.actions;
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
	// A row's own action list is part of its details: without them, the table's list stands.
	const own = opts.details ? ownActions(row, actions) : null;
	out.lines.push(`${indent}- ${cells.join(" · ")}  {id: ${row.id}}${flags.length ? ` [${flags.join(", ")}]` : ""}${own ? ` (actions: ${own.length ? own.join(", ") : "none"})` : ""}`);
	if (opts.details) {
		// A stat or detail that repeats the row line's cell of the same name is left out, as is a
		// long value (a command line, a path) that the row line or its parent row already shows.
		const shown = (label: string, value: string) => {
			const v = oneLine(value).trim();
			if (cols.some((c, i) => (c.title ?? c.key).toLowerCase() === label.toLowerCase() && plain[i] === v)) return true;
			return v.length >= 40 && (plain.includes(v) || ctx.parentCells.includes(v));
		};
		for (const s of row.stats ?? []) if (!shown(s.label, String(s.value))) out.lines.push(`${indent}    ${s.label}: ${oneLine(String(s.value))}`);
		for (const d of row.details ?? []) if (!shown(d.label, d.value)) out.lines.push(`${indent}    ${d.section && d.section !== d.label ? `${d.section} › ` : ""}${d.label}: ${oneLine(clip(d.value, 500))}`);
		// The details drawer (`pane`): forms, timelines and cards about this row.
		if (row.pane?.length) {
			const pane: Out = { lines: [], notes: [] };
			const first = row.cells[columns[0]];
			const drawer = new Set<string>(ctx.sections.map(norm));
			const title = first === null || first === undefined ? "" : typeof first === "object" ? first.text : String(first);
			if (norm(title)) drawer.add(norm(title));
			for (const k of columns) {
				const cell = row.cells[k];
				if (cell && typeof cell === "object" && cell.sub && norm(cell.sub)) drawer.add(norm(cell.sub));
			}
			for (const node of row.pane) walk(node, { ...opts, maxRows: Math.min(opts.maxRows, 20), drawer }, pane);
			for (const line of pane.lines) for (const part of line.split("\n")) if (part.trim()) out.lines.push(`${indent}    ${part.replace(/^#+ /, "")}`);
		}
	}
	for (const child of row.children ?? []) rowLines(child, cols, depth + 1, opts, out, { ...ctx, parentCells: plain });
	const omitted = (row as PagedRow).omittedChildren;
	if (omitted) out.lines.push(`${indent}  (${omitted} more row${omitted === 1 ? "" : "s"} under this one not listed; ${resume(opts, ctx.table, row.children?.length ?? 0, row.id)} to page them)`);
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
				// Ids and values appear where they differ from the label; agents can pass either.
				const options = f.options.map((o) => `${labelled(o.label, o.value)}${o.count !== undefined ? ` ${o.count}` : ""}`);
				out.lines.push(`Filter ${labelled(f.label, f.id)}: ${atDefault ? `${f.default!.label} (default: ${picked.join(", ")})` : picked.length ? picked.join(", ") : "all"}${options.length ? ` (options: ${options.join(", ")})` : ""}`);
				if (picked.length && !atDefault) out.notes.push(`filter "${f.label}" = ${picked.join(", ")}`);
				// Rows a filter the reader didn't choose leaves out, and how to include them.
				const left = f.selected.length && !opts.chosen?.includes(f.id) ? f.options.filter((o) => !f.selected.includes(o.value) && o.count !== 0) : [];
				if (left.length) {
					(out.hidden ??= []).push({ id: f.id, label: f.label, options: left.map((o) => ({ value: o.value, label: o.label, ...(o.count !== undefined && { count: o.count }) })) });
					const names = left.slice(0, 8).map((o) => `${o.label}${o.count !== undefined ? ` ${o.count}` : ""}`);
					out.lines.push(`Hidden by this filter: ${names.join(", ")}${left.length > 8 ? ` and ${left.length - 8} more` : ""}. To include them, read with view {"filters": {${JSON.stringify(f.id)}: []}} (all) or add their values.`);
				}
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
			const paged = opts.table === node.id;
			// `parent` pages one row's children as if they were the table's rows.
			const parent = paged && opts.parent ? findRow(node.rows, opts.parent) : undefined;
			const source = parent ? (parent.children ?? []) : node.rows;
			const total = source.length;
			const nested = countRows(source);
			const offset = paged ? Math.max(0, opts.offset) : 0;
			const page = pageRows(source, offset, opts.maxRows);
			const sortCol = node.sort && node.columns.find((c) => c.key === node.sort!.key);
			const rowsWord = (n: number) => `${n} row${n === 1 ? "" : "s"}`;
			out.lines.push("", `## Table ${node.id}${parent ? `, rows under ${parent.id}` : ""}: ${rowsWord(total)}${nested > total ? ` (${nested} with nested rows)` : ""}${sortCol ? `, sorted by ${sortCol.title}${node.sort!.desc ? " (descending)" : ""}` : ""}`);
			if (!total) {
				if (node.empty) out.lines.push(`(empty: ${node.empty.title}${node.empty.description ? ` — ${node.empty.description}` : ""})`);
			} else {
				out.lines.push(`Columns: ${node.columns.map((c) => c.title || c.key).join(" · ")}`);
			}
			const rowActions = actionLabels(node.actions);
			const fewer = node.rows.some((r) => ownActions(r, node.actions));
			if (rowActions.length)
				out.lines.push(`Row actions: ${rowActions.join(", ")}${fewer ? (opts.details ? " (a row that allows fewer lists its own)" : ` (a row may allow fewer: ${detailsOn(opts)} to list each row's own)`) : ""}`);
			if (!opts.details && hasDetails(page.rows)) out.lines.push(`(rows' details left out: ${detailsOn(opts)} to include them)`);
			const bulk = actionLabels(node.bulkActions);
			if (bulk.length) out.lines.push(`Bulk actions: ${bulk.join(", ")}`);
			const sections = sectionPaths(node.sections);
			const used = new Set<string>();
			let header = "";
			// Rows render one at a time and stop before the result outgrows its budget.
			let shown = 0;
			let stopped: number | null = null;
			for (const row of page.rows) {
				const rowOut: Out = { lines: [], notes: [] };
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
					if (h) rowOut.lines.push(`### ${h}`);
				}
				rowLines(row, node.columns, 0, opts, rowOut, { table: node.id, actions: node.actions, parentCells: [], sections: h ? h.split(" › ") : [] });
				if (sizeOf(out) + sizeOf(rowOut) > opts.budget - HINT_ROOM && out.rowsShown) {
					stopped = offset + shown;
					break;
				}
				out.lines.push(...rowOut.lines);
				out.rowsShown = (out.rowsShown ?? 0) + 1;
				shown++;
			}
			const rows = page.rows.slice(0, shown);
			// Empty sections are only known when every row was looked at.
			const empty = [...sections].filter(([id]) => !used.has(id)).map(([, p]) => p.labels.filter((l, i, all) => l !== all[i - 1]).join(" › "));
			if (empty.length && offset === 0 && rows.length === total && stopped === null && !parent) out.lines.push(`Empty sections: ${empty.join(", ")}`);
			// Offsets and "of N" count top-level rows; max_rows counts nested rows too.
			const unit = nested > total ? " (offsets count top-level rows; max_rows counts nested rows too)" : "";
			const under = parent?.id;
			if (total && offset >= total) out.lines.push(`(offset ${offset} is past the end: there ${total === 1 ? "is 1 row" : `are ${total} rows`}; offsets start at 0)`);
			else if (stopped !== null)
				out.lines.push(
					rows.length
						? `(showing rows ${offset + 1}–${stopped} of ${total}: the result reached its size limit; ${resume(opts, node.id, stopped, under)}${opts.details ? `, or ${detailsOff(opts)} for shorter rows` : ""})`
						: `(${rowsWord(total - offset)} not listed: the result reached its size limit; ${resume(opts, node.id, stopped, under)})`,
				);
			else if (total && !rows.length) out.lines.push(`(${rowsWord(total)} not listed: max_rows is 0)`);
			else if (page.next !== null) out.lines.push(`(showing rows ${offset + 1}–${page.next} of ${total}${unit}; ${resume(opts, node.id, page.next, under)} for more)`);
			return;
		}
		case "list": {
			// In a drawer, an empty list says nothing.
			if (opts.drawer && !node.items.length) return;
			// Under a heading of its own (a card's title), the heading names it; otherwise
			// empty, the plugin's empty message says so, with no "0 items" beside it.
			if (!underHeading(out)) out.lines.push("", node.items.length || !node.empty ? `## List: ${node.items.length} item${node.items.length === 1 ? "" : "s"}` : "## List");
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
			// An untitled form needs no heading; a field with neither label nor value says nothing.
			out.lines.push("");
			if (node.title || node.description) out.lines.push(`## Form${node.title ? `: ${node.title}` : ""}${node.description ? ` — ${node.description}` : ""}`);
			for (const f of node.fields) {
				const value = oneLine(fieldText(f, now)).trim();
				// In a drawer: an empty field, or a value the row line or its section already shows, is left out.
				if (opts.drawer && (emptyField(f) || opts.drawer.has(value))) continue;
				if (f.label || value) out.lines.push(`- ${f.label ? `${oneLine(f.label)}: ` : ""}${value}`);
			}
			return;
		case "empty":
			out.lines.push(`(empty: ${node.title}${node.description ? ` — ${node.description}` : ""})`);
			return;
		case "text":
			if (opts.drawer && (!node.text.trim() || opts.drawer.has(norm(node.text)))) return;
			out.lines.push(node.text);
			return;
		case "card": {
			const acts = actionLabels(node.actions);
			const body: Out = { lines: ["", `## ${node.title ?? "Card"}${node.description ? ` — ${node.description}` : ""}`], notes: out.notes };
			for (const child of node.children) walk(child, opts, body);
			if (acts.length) body.lines.push(`Actions: ${acts.join(", ")}`);
			// A card with nothing in it (its timeline empty, say) and nothing to say about itself is left out.
			if (body.lines.length === 2 && !node.description) return;
			out.lines.push(...body.lines);
			return;
		}
		case "details":
			for (const i of node.items) {
				if (opts.drawer && (!i.value.trim() || opts.drawer.has(norm(i.value)))) continue;
				out.lines.push(`- ${i.label ? `${i.label}: ` : ""}${oneLine(clip(i.value, 1000))}`);
			}
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
			// In a drawer, an empty timeline says nothing. Under a heading of its own (a card's
			// title, "Updates · 3"), the heading names it and the entries count themselves.
			if (opts.drawer && !node.entries.length) return;
			if (!underHeading(out)) out.lines.push("", node.entries.length || !node.empty ? `## Timeline: ${node.entries.length} entr${node.entries.length === 1 ? "y" : "ies"}` : "## Timeline");
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
		maxRows: options.maxRows ?? DEFAULT_ROWS,
		budget: options.budget ?? TEXT_BUDGET,
		parent: options.parent,
		resource: options.resource,
		offset: options.offset ?? 0,
		details: options.details ?? false,
		now: options.now ?? Date.now(),
		table: options.table,
		chosen: options.chosen,
	}, out);
	const lines = out.lines.flatMap((l) => l.split("\n"));
	while (lines[0] === "") lines.shift();
	let text = lines.join("\n");
	// Content outside tables (logs, Markdown) can still overflow: cut at a line, and say where.
	const budget = options.budget ?? TEXT_BUDGET;
	if (text.length > budget) {
		const kept = lines.slice(0, text.slice(0, budget).split("\n").length - 1);
		const shorter = options.details ? (options.resource ? ", or add details=false" : ", or pass details: false") : "";
		text = `${kept.join("\n")}\n(truncated after line ${kept.length} of ${lines.length} at the result's size limit; read one table at a time with ${options.resource ? "?table=…&offset=…" : "table and offset"}${shorter})`;
	}
	return { text, viewState: out.notes, hidden: out.hidden ?? [] };
}

/** Protocol fields that hold epoch-millisecond times: JSON gets an ISO 8601 copy beside each (`atIso`). */
const TIME_KEYS = ["at", "metaAt", "edited"];
/** Row fields that are the row's inspector details (and its own action list), left out with `details: false`. */
const DETAIL_KEYS = ["details", "stats", "pane", "actions"];
/**
 * Protocol fields that only affect how the UI looks or is operated (icons, sizes, emphasis,
 * placeholders, drag and drop): left out of agent JSON. Plugin-chosen keys (a row's
 * `cells`, a field's `value`) are never touched.
 */
const VISUAL_KEYS = new Set([
	"icon", "dropIcon", "dropLabel", "width", "minWidth", "maxWidth", "grow", "shrink", "wide", "align", "resizable",
	"inset", "mono", "muted", "strong", "style", "titleStyle", "appearance", "autofocus", "placeholder",
	"pill", "overflow", "layoutVersion", "selectEvents", "reorderOnto", "reorderable", "sortable", "focus",
	"priority", "optional", "sortDesc", "collapsed", "contextSelect", "paneButtons", "enter", "inline", "primary",
	"shade", "shades", "colors", "heading", "collapsible",
]);
/**
 * Keys whose name other protocol objects use for data, left out only where they are visual:
 * `color` except on a status dot (where it is the state), an action's keyboard `key` and menu
 * `group` (an object with an `id` and a `label`; a row's `group` is data), a section's drag `order`
 * a textarea's height in `rows` and a card's `open` (whether a collapsible card starts open; an
 * agent reads its children either way).
 */
function visualHere(key: string, value: unknown, o: Record<string, unknown>, parentKey: string): boolean {
	if (key === "open") return o.type === "card";
	if (key === "color") return parentKey !== "dot";
	if (key === "key" || key === "group") return typeof value === "string" && typeof o.id === "string" && typeof o.label === "string";
	if (key === "order") return !Array.isArray(value);
	if (key === "rows") return typeof value === "number";
	return false;
}
/** Field types whose choices (`options`, a tags field's `keys`) are repeated in every row's drawer. */
const CHOICE_FIELDS = new Set(["select", "combobox", "tags"]);
/** `cells` is keyed by the plugin's column keys (its values are protocol cells); a field's `value` is plugin data. */
type DataScope = false | "keys" | "all";
const dataScope = (key: string, scope: DataScope): DataScope => (scope === "all" || key === "value" ? "all" : key === "cells" ? "keys" : false);

/**
 * A surface as redacted JSON for agents: the tree without visual-only fields, tables paged like
 * text (`maxRows` rows counting children, from `offset` for `table`), and outer tables cut at a
 * row boundary when the whole result would outgrow `budget` characters. A paged table gets
 * `paging: { offset, total, next }`, with `reason: "size"` when the budget cut it.
 */
export function treeJson(tree: Node, options: ReadOptions = {}): Node {
	const maxRows = options.maxRows ?? DEFAULT_ROWS;
	const details = options.details ?? false;
	const budget = options.budget ?? JSON_BUDGET;
	const outer: Record<string, unknown>[] = [];
	const cut = (value: unknown, ctx: { row: boolean; inRow: boolean; data: DataScope; key?: string }): unknown => {
		if (Array.isArray(value)) return value.map((v) => cut(v, { ...ctx }));
		if (!value || typeof value !== "object") return value;
		const source = value as Record<string, unknown>;
		const o: Record<string, unknown> = {};
		// A choice field in a row's drawer: its value's labels instead of the choices, which every row repeats.
		const choices = !ctx.data && ctx.inRow && typeof source.type === "string" && CHOICE_FIELDS.has(source.type) && "value" in source;
		for (const [k, v] of Object.entries(source)) {
			if (!ctx.data && (VISUAL_KEYS.has(k) || visualHere(k, v, source, ctx.key ?? ""))) continue;
			if (ctx.row && !details && DETAIL_KEYS.includes(k)) continue;
			if (choices && (k === "options" || k === "keys")) continue;
			// Rows (and their children) are the objects under a table's `rows`.
			const row = !ctx.data && (k === "rows" || (ctx.row && k === "children"));
			o[k] = cut(v, { row, inRow: ctx.inRow || ctx.row, data: ctx.data === "keys" ? false : dataScope(k, ctx.data), key: k });
			if (!ctx.data && TIME_KEYS.includes(k) && typeof v === "number") o[`${k}Iso`] = new Date(v).toISOString();
		}
		if (choices) {
			const f = source as Field;
			if (f.type === "tags") o.valueLabels = tagLabels(f);
			else o.valueLabel = fieldText(f, 0);
		}
		if (!ctx.data && o.type === "table" && Array.isArray(o.rows)) {
			const paged = options.table === o.id;
			const offset = paged ? Math.max(0, options.offset ?? 0) : 0;
			const parent = paged && options.parent ? findRow(o.rows as Row[], options.parent) : undefined;
			const source = parent ? ((parent.children ?? []) as Row[]) : (o.rows as Row[]);
			const total = source.length;
			const page = pageRows(source, offset, maxRows);
			o.rows = page.rows;
			if (parent) o.parent = parent.id;
			if (offset || page.next !== null || parent) o.paging = { offset, total, next: page.next, ...(parent ? { parent: parent.id } : {}) };
			if (!ctx.inRow) outer.push(o);
		}
		return o;
	};
	const result = cut(redact(tree), { row: false, inRow: false, data: false }) as Node;
	if (JSON.stringify(result).length <= budget) return result;
	// Over budget: keep rows table by table, in order, while they fit.
	const all = outer.map((t) => t.rows as unknown[]);
	for (const t of outer) t.rows = [];
	let size = JSON.stringify(result).length + outer.length * 80; // room for paging notes
	outer.forEach((t, i) => {
		const rows = all[i];
		let kept = 0;
		for (const r of rows) {
			const n = JSON.stringify(r).length + 1;
			if (size + n > budget && (kept || size > budget)) break;
			size += n;
			kept++;
		}
		t.rows = rows.slice(0, kept);
		if (kept < rows.length) {
			const paging = (t.paging as { offset: number; total: number; parent?: string } | undefined) ?? { offset: 0, total: rows.length };
			t.paging = { ...paging, next: paging.offset + kept, reason: "size" };
		}
	});
	return result;
}

/** Lines that describe a screen's controls, not its content: search skips them. */
const CONTROL_LINE = /^(#|Columns:|Row actions:|Bulk actions:|Toolbar actions:|Actions:|Filter |Hidden by this filter:|Control |Empty sections:|\(showing|\(offset |\(\d+ (rows?|items) not listed|\(truncated)/;
const ROW_LINE = /^- .*\{id: [^}]*\}/;
export const SEARCH_CLIP = 300;

/** A long line shortened to `n` characters, keeping a row's trailing `{id: …}` and flags. */
export function clipLine(line: string, n = SEARCH_CLIP) {
	if (line.length <= n) return line;
	const tail = line.match(/\s+\{id: [^}]*\}.*$/)?.[0] ?? "";
	return `${line.slice(0, Math.max(20, n - tail.length - 1)).trimEnd()}…${tail.length <= n / 2 ? tail : ""}`;
}
/** The part of a long line around `word`. */
function around(line: string, word: string, n = 160) {
	const at = line.toLowerCase().indexOf(word);
	if (line.length <= n || at < 0) return clipLine(line, n);
	const start = Math.max(0, at - Math.floor(n / 3));
	return `${start ? "…" : ""}${line.slice(start, start + n).trim()}${start + n < line.length ? "…" : ""}`;
}

export type SearchHit = {
	/** The heading the match is under: a table's section, or a card or form title. */
	section: string;
	/** The matching row's line (or the matching line, outside rows), shortened. */
	line: string;
	/** The row's matching detail lines, and where the row line was shortened past a match, the part around it. */
	matched: string[];
};

/** A word without its ending, for closest matches: "renewal" → "renew", "laptops" → "lapto". */
export const stem = (word: string) => (word.length > 5 ? word.slice(0, Math.max(5, word.length - 3)) : word);

/**
 * Content lines of a screen's text that contain every word (or at least `need` of them), grouped
 * by row: a row that matches on its line and its details is one hit. Lines are shortened to
 * SEARCH_CLIP characters.
 */
export function searchText(text: string, words: string[], need = words.length): SearchHit[] {
	const hits: SearchHit[] = [];
	let section = "";
	let row: { indent: number; line: string; hit?: SearchHit } | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (/^#{2,3} /.test(raw)) {
			section = raw.replace(/^#+ /, "");
			row = null;
			continue;
		}
		const indent = raw.length - raw.trimStart().length;
		const isRow = ROW_LINE.test(line);
		if (isRow) row = { indent, line };
		else if (row && indent <= row.indent) row = null;
		if (!line || CONTROL_LINE.test(line)) continue;
		const lower = line.toLowerCase();
		const found = words.filter((w) => lower.includes(w));
		if (!found.length || found.length < need) continue;
		const shortened = clipLine(line);
		const lost = shortened !== line ? found.find((w) => !shortened.toLowerCase().includes(w)) : undefined;
		if (row) {
			if (!row.hit) {
				row.hit = { section, line: clipLine(row.line.replace(/^- /, "")), matched: [] };
				hits.push(row.hit);
			}
			if (!isRow) row.hit.matched.push(shortened);
			if (lost) row.hit.matched.push(around(line, lost));
		} else hits.push({ section, line: shortened, matched: lost ? [around(line, lost)] : [] });
	}
	return hits;
}
