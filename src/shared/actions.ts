// The action resolver (docs/architecture.md, "Action resolver"): what a plugin's tree offers, and
// whether an event matches it. Pure code shared by the renderer, which builds every event payload
// through `payloadFor`, and the host, which checks every person's event (`checkEvent`) against
// the person's current tree before the plugin hears it. Agents resolve their addresses with
// `resolve`. Nothing here changes the protocol: it maps today's event names and payloads
// (`EventPayloads` in protocol.ts) back onto the tree.
import { HUES, type Action, type Cell, type Dialog, type EventPayloads, type Field, type Node, type Row, type TagValue, type TimelineEntry, type ViewDeclaration } from "./protocol";
import { flatSections, rowSection } from "./sections";
import { viewChange } from "./views";

export type FieldValue = EventPayloads["field"]["value"];

/**
 * Where an action event points in a tree. `row` is the row the action runs on: a table row, a
 * list item (with `list` to tell lists apart), or the row whose drawer (`pane`) holds the
 * timeline, composer, list or form that sends it. `card` is a boxed card's `id`. `list` with
 * `item` is a list's `open` action on that item; `form`, `field` and `tag` a `tags` field's
 * `open` on that pill. `table`, `list` and `dialog` narrow where to look.
 */
export type ActionAddress = {
	kind: "action";
	action: string;
	row?: string;
	rows?: string[];
	table?: string;
	list?: string;
	item?: string;
	dialog?: string;
	card?: string;
	target?: string;
	timeline?: string;
	entry?: string;
	composer?: string;
	form?: string;
	field?: string;
	tag?: TagValue;
	text?: string;
};

/** Where an action or field event points in a tree. */
export type Address =
	| ActionAddress
	/** `row`: the row whose drawer holds the form. `secret`: the renderer's mark on a Keychain-backed field. */
	| { kind: "field"; form: string; field: string; row?: string; value: FieldValue; secret?: string }
	| { kind: "dialog-close"; dialog: string }
	| { kind: "reorder"; table: string; row: string; section: string; before: string | null; onto?: string }
	| { kind: "select"; table: string; row: string | null };

/** What an address or event resolved to in the tree. */
export type Resolved = {
	/** The event name sent to the plugin. */
	name: string;
	/** Exactly what the renderer sends. */
	payload: unknown;
	/** The action's definition in the tree. */
	action?: Action;
	/** Where it was found, in words: "row menu of 'Fix login' in table tasks". */
	place: string;
	/** The rows it acts on, with their titles. */
	rows: { id: string; title: string }[];
	confirm?: string;
};

export type Refused = { refused: string };

/** An action and its split-button alternatives (`Action.menu`), which send their own ids with the same payload. */
export const withAlternatives = (actions: Action[]): Action[] => actions.flatMap((a) => [a, ...(a.menu ?? [])]);

/** A timeline entry's actions; editing in place (`edit`) comes first. */
export const entryActions = (node: Extract<Node, { type: "timeline" }>, e: TimelineEntry): Action[] => {
	const all = [...(node.edit ? [node.edit] : []), ...(node.actions ?? [])];
	return e.actions ? all.filter((a) => a === node.edit || e.actions!.includes(a.id)) : all;
};

/** Events from inside a row's drawer carry that row's id as `rowId` (replacing one the event had). */
export const inPane = (payload: Record<string, unknown>, row: string | undefined): Record<string, unknown> =>
	row === undefined ? payload : { ...payload, rowId: row };

/**
 * The payload the renderer sends for an address, keys in the renderer's order. A row action's
 * `rowId` comes first; inside a drawer (timeline, composer, list `open`, tag `open`) it comes last,
 * where the drawer adds it.
 */
export function payloadFor(address: Address): Record<string, unknown> {
	switch (address.kind) {
		case "field":
			return {
				form: address.form,
				field: address.field,
				value: address.value,
				...(address.secret !== undefined ? { secret: address.secret } : {}),
				...(address.row !== undefined ? { rowId: address.row } : {}),
			};
		case "dialog-close":
			return { dialog: address.dialog };
		case "select":
			return { table: address.table, rowId: address.row };
		case "reorder":
			return address.onto !== undefined
				? { table: address.table, rowId: address.row, section: address.section, before: null, onto: address.onto }
				: { table: address.table, rowId: address.row, section: address.section, before: address.before };
	}
	const a = address;
	const tail = a.timeline !== undefined || a.composer !== undefined || a.item !== undefined || a.form !== undefined;
	const rowId = a.row ?? a.card;
	const p: Record<string, unknown> = {};
	if (rowId !== undefined && !tail) p.rowId = rowId;
	if (a.rows !== undefined) p.rowIds = [...a.rows];
	if (a.target !== undefined) p.target = a.target;
	if (a.timeline !== undefined) (p.timeline = a.timeline), (p.entryId = a.entry);
	if (a.item !== undefined) (p.list = a.list), (p.item = a.item);
	if (a.form !== undefined) (p.form = a.form), (p.field = a.field), (p.key = a.tag?.key), (p.value = a.tag?.value);
	if (a.composer !== undefined) p.composer = a.composer;
	if (a.dialog !== undefined) p.dialog = a.dialog;
	if (a.text !== undefined) p.text = a.text;
	if (rowId !== undefined && tail) p.rowId = rowId;
	return p;
}

// ── What a tree offers ───────────────────────────────────────────────────

type Table = Extract<Node, { type: "table" }>;
type Control = Extract<Node, { type: "segmented" | "choice" }>;

/** A place the renderer sends an action event from, with the payload it sends. */
type Offer = {
	name: string;
	action: Action;
	place: string;
	/** The payload without its optional parts. */
	base: Record<string, unknown>;
	/** Values `target` may take (a row's `targets` for the action). */
	targets?: string[];
	/** The event carries what was written (`input` actions, composers, timeline edits). */
	text: boolean;
	/** Bulk actions: the table whose rows `rowIds` names. */
	bulk?: Map<string, string>;
	rows: { id: string; title: string }[];
	table?: string;
	list?: string;
	dialog?: string;
};

type FieldSpot = { form: string; field: Field | Control; row?: string; place: string };

type Offered = {
	offers: Offer[];
	fields: FieldSpot[];
	tables: { node: Table; pane?: string; titles: Map<string, string> }[];
	pages: Extract<Node, { type: "page" }>[];
};

const cellText = (cell: Cell | undefined): string =>
	cell === undefined || cell === null ? "" : typeof cell === "object" ? cell.text : String(cell);
const quote = (s: string) => JSON.stringify(s.length > 64 ? `${s.slice(0, 63)}…` : s);

/** Everything a tree offers the person: actions, fields, tables and pages. */
function offered(tree: Node): Offered {
	const out: Offered = { offers: [], fields: [], tables: [], pages: [] };
	type Ctx = { pane?: { row: string; title: string }; dialog?: Dialog };
	const inDrawer = (ctx: Ctx, place: string) => (ctx.pane ? `${place} in the drawer of ${quote(ctx.pane.title || ctx.pane.row)}` : place);
	const paneRows = (ctx: Ctx) => (ctx.pane ? [{ id: ctx.pane.row, title: ctx.pane.title }] : []);
	const offer = (ctx: Ctx, o: Omit<Offer, "base" | "rows" | "text" | "place"> & { base: Record<string, unknown>; place: string; text?: boolean; rows?: Offer["rows"] }) =>
		out.offers.push({ ...o, base: inPane(o.base, ctx.pane?.row), place: inDrawer(ctx, o.place), text: o.text ?? !!o.action.input, rows: o.rows ?? paneRows(ctx), ...(ctx.dialog ? { dialog: ctx.dialog.id } : {}) });
	const control = (c: Control, ctx: Ctx) => void out.fields.push({ form: c.id, field: c, row: ctx.pane?.row, place: inDrawer(ctx, `control ${quote(c.label ?? c.id)}`) });

	const table = (node: Table, ctx: Ctx) => {
		// `contextSelect`: a context row acts as the row it stands for, and its events name that row.
		const standFor = new Map<string, string>();
		const titles = new Map<string, string>();
		const key = node.columns[0]?.key;
		const index = (rows: Row[]) =>
			rows.forEach((r) => {
				if (node.contextSelect && r.context !== undefined) standFor.set(r.id, r.context);
				if (!titles.has(r.id) || r.context === undefined) titles.set(r.id, key ? cellText(r.cells[key]) : "");
				if (r.children) index(r.children);
			});
		index(node.rows);
		const as = (id: string) => standFor.get(id) ?? id;
		out.tables.push({ node, pane: ctx.pane?.row, titles });
		const all = node.actions ?? [];
		const visit = (r: Row) => {
			const id = as(r.id);
			const title = titles.get(r.id) ?? "";
			const rows = [{ id, title }];
			const acts = r.actions ? all.filter((a) => r.actions!.includes(a.id)) : all;
			for (const a of acts)
				for (const x of [a, ...(a.menu ?? [])]) {
					const targets = [...(r.targets?.[x.id] ?? []), ...(x !== a ? (r.targets?.[a.id] ?? []) : [])].map((t) => t.id);
					offer(ctx, { name: x.id, action: x, place: `row ${quote(title || r.id)} in table ${quote(node.id)}`, base: { rowId: id }, targets, rows, table: node.id });
				}
			if (r.pane) for (const n of r.pane) walk(n, { ...ctx, pane: { row: id, title } });
			else
				for (const d of r.details ?? [])
					for (const a of d.actions ?? []) {
						const on = d.actionRow !== undefined ? as(d.actionRow) : id;
						offer(ctx, {
							name: a.id,
							action: a,
							place: `detail ${quote(d.label)} of row ${quote(title || r.id)} in table ${quote(node.id)}`,
							base: { rowId: on, ...(d.target !== undefined ? { target: d.target } : {}) },
							rows: [{ id: on, title: titles.get(d.actionRow ?? r.id) ?? "" }],
							table: node.id,
						});
					}
			r.children?.forEach(visit);
		};
		node.rows.forEach(visit);
		for (const a of withAlternatives(node.bulkActions ?? []))
			offer(ctx, { name: a.id, action: a, place: `bulk actions of table ${quote(node.id)}`, base: {}, bulk: titles, rows: [], table: node.id });
	};

	const walk = (node: Node, ctx: Ctx): void => {
		switch (node.type) {
			case "page":
				out.pages.push(node);
				for (const a of withAlternatives(node.actions ?? [])) offer(ctx, { name: a.id, action: a, place: "toolbar", base: {} });
				node.controls?.forEach((c) => control(c, ctx));
				node.children.forEach((c) => walk(c, ctx));
				if (node.dialog) {
					const d = node.dialog;
					const inDialog = { ...ctx, dialog: d };
					// Dialog buttons send directly: no confirmation or input step.
					for (const a of withAlternatives(d.actions ?? [])) offer(inDialog, { name: a.id, action: a, place: `dialog ${quote(d.title)}`, base: { dialog: d.id }, text: false });
					d.children.forEach((c) => walk(c, inDialog));
				}
				return;
			case "floating":
				for (const a of node.actions ?? []) offer(ctx, { name: a.id, action: a, place: "floating window", base: {}, text: false });
				for (const s of node.suggestions ?? []) offer(ctx, { name: s.id, action: { id: s.id, label: s.label }, place: "suggestions", base: {}, text: false });
				node.children.forEach((c) => walk(c, ctx));
				return;
			case "stack":
				node.children.forEach((c) => walk(c, ctx));
				return;
			case "card":
				if (ctx.pane)
					// A drawer section: plain buttons, sent with the drawer's row.
					for (const a of node.actions ?? []) offer(ctx, { name: a.id, action: a, place: `section ${quote(node.title ?? node.id ?? "")}`, base: {} });
				else
					for (const a of withAlternatives(node.actions ?? []))
						offer(ctx, { name: a.id, action: a, place: `card ${quote(node.title ?? node.id ?? "")}`, base: node.id !== undefined ? { rowId: node.id } : {} });
				node.children.forEach((c) => walk(c, ctx));
				return;
			case "table":
				return table(node, ctx);
			case "list":
				for (const it of node.items) {
					for (const a of withAlternatives(it.actions ?? []))
						offer(ctx, { name: a.id, action: a, place: `item ${quote(it.title)} in list ${quote(node.id)}`, base: { rowId: it.id }, rows: [{ id: it.id, title: it.title }], list: node.id });
					if (node.open)
						offer(ctx, { name: node.open.id, action: node.open, place: `item ${quote(it.title)} in list ${quote(node.id)}`, base: { list: node.id, item: it.id }, text: false, rows: [{ id: it.id, title: it.title }], list: node.id });
				}
				return;
			case "form":
				for (const f of node.fields) {
					out.fields.push({ form: node.id, field: f, row: ctx.pane?.row, place: inDrawer(ctx, `field ${quote(f.label || f.id)} of form ${quote(node.id)}`) });
					if (f.type === "tags" && f.open)
						for (const t of f.value)
							offer(ctx, { name: f.open.id, action: f.open, place: `field ${quote(f.label || f.id)} of form ${quote(node.id)}`, base: { form: node.id, field: f.id, key: t.key, value: t.value }, text: false });
				}
				return;
			case "timeline":
				for (const e of node.entries)
					for (const a of entryActions(node, e))
						offer(ctx, { name: a.id, action: a, place: `entry ${quote(e.id)} of timeline ${quote(node.id)}`, base: { timeline: node.id, entryId: e.id }, text: a === node.edit || !!a.input });
				return;
			case "composer":
				offer(ctx, { name: node.action.id, action: node.action, place: `composer ${quote(node.id)}`, base: { composer: node.id }, text: true });
				return;
			case "segmented":
			case "choice":
				return control(node, ctx);
			default:
				return;
		}
	};
	walk(tree, {});
	return out;
}

// ── Checking events ──────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => a === b || (typeof a === "object" && a !== null && JSON.stringify(a) === JSON.stringify(b));
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const refuse = (refused: string): Refused => ({ refused });
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** The payload's keys are exactly these (absent optional ones allowed). */
function onlyKeys(p: Record<string, unknown>, required: string[], optional: string[] = []): string | null {
	for (const k of required) if (!(k in p)) return `its payload has no ${k}`;
	for (const k of Object.keys(p)) if (!required.includes(k) && !optional.includes(k)) return `its payload has an unexpected ${quote(k)}`;
	return null;
}

function fits(o: Offer, p: Record<string, unknown>, ignore: "target" | "text" | null = null): boolean {
	for (const [k, v] of Object.entries(o.base)) if (v !== undefined && !same(p[k], v)) return false;
	for (const k of Object.keys(p)) {
		if (o.base[k] !== undefined) continue;
		if (k === "target" && (ignore === "target" || o.targets?.includes(p.target as string))) continue;
		if (k === "text" && (ignore === "text" || o.text)) continue;
		if (k === "rowIds" && o.bulk) continue;
		return false;
	}
	if (o.text && ignore !== "text" && !nonEmpty(p.text)) return false;
	if (o.bulk && !(strings(p.rowIds) && p.rowIds.length > 0 && p.rowIds.every((id) => o.bulk!.has(id)))) return false;
	return true;
}

function matchAction(found: Offered, name: string, p: Record<string, unknown>, address?: ActionAddress, unique = false): Resolved | Refused {
	let named = found.offers.filter((o) => o.name === name);
	if (address?.table !== undefined) named = named.filter((o) => o.table === address.table);
	if (address?.list !== undefined) named = named.filter((o) => o.list === address.list);
	if (address?.dialog !== undefined) named = named.filter((o) => o.dialog === address.dialog);
	if (!named.length) return refuse(`${quote(name)} isn't offered on this screen`);
	const fitting = named.filter((o) => fits(o, p));
	const enabled = fitting.filter((o) => !o.action.disabled);
	if (unique && new Set(enabled.map((o) => o.place)).size > 1)
		return refuse(`${quote(name)} is offered in several places (${[...new Set(enabled.map((o) => o.place))].slice(0, 5).join("; ")})`);
	const o = enabled[0];
	if (o) {
		const rows = o.bulk ? (p.rowIds as string[]).map((id) => ({ id, title: o.bulk!.get(id) ?? "" })) : o.rows;
		return { name, payload: p, action: o.action, place: o.place, rows, ...(o.action.confirm !== undefined ? { confirm: o.action.confirm } : {}) };
	}
	if (fitting.length) return refuse(`${quote(name)} is disabled (${fitting[0]!.place})`);
	// Why nothing fits, most specific first.
	if (typeof p.rowId === "string" && !named.some((o) => o.base.rowId === p.rowId)) {
		const known = found.offers.some((o) => o.base.rowId === p.rowId) || found.tables.some((t) => t.titles.has(p.rowId as string));
		return refuse(known ? `${quote(name)} isn't offered for row ${quote(p.rowId)}` : `row ${quote(p.rowId)} isn't on the screen`);
	}
	if (named.some((o) => o.bulk) && "rowIds" in p) {
		const missing = strings(p.rowIds) ? p.rowIds.find((id) => !named.some((o) => o.bulk?.has(id))) : undefined;
		return refuse(missing !== undefined ? `row ${quote(missing)} isn't on the screen` : `${quote(name)} needs the rows it acts on`);
	}
	if (p.target !== undefined && named.some((o) => fits(o, p, "target"))) return refuse(`target ${quote(String(p.target))} isn't offered for ${quote(name)}`);
	if (named.some((o) => fits(o, p, "text"))) return refuse(named.some((o) => o.text) ? `${quote(name)} needs text` : `${quote(name)} takes no text`);
	return refuse(`${quote(name)} isn't offered there (${named[0]!.place})`);
}

/** Whether a field event's value has the shape its field's type takes. */
function valueFits(field: Field | Control, value: unknown): boolean {
	const str = typeof value === "string";
	switch (field.type) {
		case "segmented":
		case "choice":
		case "select":
			return str && field.options.some((o) => o.value === value);
		case "text":
			return str || (field.secret !== undefined && (value === null || value === false));
		case "textarea":
		case "datetime":
		case "combobox":
			return str;
		case "switch":
			return typeof value === "boolean";
		case "color":
			return str && (HUES as readonly string[]).includes(value);
		case "duration":
			return value === null || (typeof value === "number" && Number.isFinite(value));
		case "tags":
			return Array.isArray(value) && value.every((t) => isRecord(t) && typeof t.key === "string" && (t.value === undefined || typeof t.value === "string"));
		case "options":
			return Array.isArray(value) && value.every((o) => isRecord(o) && typeof o.text === "string" && (o.key === undefined || typeof o.key === "string") && (o.color === undefined || typeof o.color === "string"));
		case "environment":
			return (
				Array.isArray(value) &&
				value.every((e) => isRecord(e) && typeof e.key === "string" && typeof e.value === "string" && typeof e.selected === "boolean" && typeof e.secret === "boolean")
			);
	}
}

const secretOf = (f: Field | Control) => (f.type === "text" ? f.secret : f.type === "environment" ? f.secretPrefix : undefined);

function checkField(found: Offered, p: Record<string, unknown>, declared?: ViewDeclaration): Resolved | Refused {
	const bad = onlyKeys(p, ["form", "field", "value"], ["rowId", "secret"]);
	if (bad) return refuse(bad);
	if (typeof p.form !== "string" || typeof p.field !== "string") return refuse("its form and field must be text");
	if (p.rowId !== undefined && typeof p.rowId !== "string") return refuse("its rowId must be text");
	const named = found.fields.filter((s) => s.form === p.form && s.field.id === p.field);
	const spot = named.find((s) => s.row === p.rowId);
	if (!spot) {
		// A page control the SDK keeps in the view, even when the tree doesn't show it.
		if (p.rowId === undefined && p.secret === undefined && viewChange(declared, {}, "field", p)) return { name: "field", payload: p, place: `control ${quote(p.field)}`, rows: [] };
		if (!named.length) return refuse(`field ${quote(`${p.form}.${p.field}`)} isn't on the screen`);
		return refuse(p.rowId === undefined ? `field ${quote(`${p.form}.${p.field}`)} is in a row's drawer` : `field ${quote(`${p.form}.${p.field}`)} isn't in the drawer of row ${quote(p.rowId as string)}`);
	}
	if (p.secret !== undefined && p.secret !== secretOf(spot.field)) return refuse(`field ${quote(`${p.form}.${p.field}`)} isn't a secret field`);
	if (!valueFits(spot.field, p.value)) return refuse(`its value doesn't fit ${quote(`${p.form}.${p.field}`)} (a ${spot.field.type} field)`);
	return { name: "field", payload: p, place: spot.place, rows: spot.row !== undefined ? [{ id: spot.row, title: "" }] : [] };
}

/** The table `id` as the tree has it (outside drawers, whose events carry another row). */
const tableOf = (found: Offered, id: unknown) => found.tables.find((t) => t.node.id === id && t.pane === undefined);

function checkBuiltIn(found: Offered, name: string, p: Record<string, unknown>, declared?: ViewDeclaration): Resolved | Refused | null {
	const ok = (place: string, rows: Resolved["rows"] = []): Resolved => ({ name, payload: p, place, rows });
	const page = found.pages[0];
	switch (name) {
		case "field":
			return checkField(found, p, declared);
		case "dialog-close": {
			const bad = onlyKeys(p, ["dialog"]);
			if (bad) return refuse(bad);
			const d = found.pages.find((pg) => pg.dialog?.id === p.dialog)?.dialog;
			return d ? ok(`dialog ${quote(d.title)}`) : refuse(`dialog ${quote(String(p.dialog))} isn't open`);
		}
		case "select": {
			const bad = onlyKeys(p, ["table", "rowId"]);
			if (bad) return refuse(bad);
			const t = tableOf(found, p.table);
			if (!t?.node.selectEvents) return refuse(`table ${quote(String(p.table))} doesn't send selections`);
			if (p.rowId === null) return ok(`table ${quote(t.node.id)}`);
			const ids = selectable(t.node);
			return typeof p.rowId === "string" && ids.has(p.rowId) ? ok(`table ${quote(t.node.id)}`, [{ id: p.rowId, title: t.titles.get(p.rowId) ?? "" }]) : refuse(`row ${quote(String(p.rowId))} isn't on the screen`);
		}
		case "reorder": {
			const bad = onlyKeys(p, ["table", "rowId", "section", "before"], ["onto"]);
			if (bad) return refuse(bad);
			const t = tableOf(found, p.table);
			if (!t?.node.reorder) return refuse(`table ${quote(String(p.table))} can't be reordered`);
			const has = (id: unknown) => typeof id === "string" && t.titles.has(id);
			if (!has(p.rowId)) return refuse(`row ${quote(String(p.rowId))} isn't on the screen`);
			if (p.before !== null && !has(p.before)) return refuse(`row ${quote(String(p.before))} isn't on the screen`);
			const sections = new Set(["", ...flatSections(t.node.sections).map((s) => s.id), ...t.node.rows.map((r) => rowSection(r, t.node.sections))]);
			if (typeof p.section !== "string" || !sections.has(p.section)) return refuse(`section ${quote(String(p.section))} isn't in table ${quote(t.node.id)}`);
			if (p.onto !== undefined) {
				if (t.node.reorderOnto === undefined) return refuse(`table ${quote(t.node.id)} takes no drops onto rows`);
				if (p.before !== null || typeof p.onto !== "string" || !selectable(t.node).has(p.onto)) return refuse(`row ${quote(String(p.onto))} isn't on the screen`);
			}
			return ok(`table ${quote(t.node.id)}`, [{ id: p.rowId as string, title: t.titles.get(p.rowId as string) ?? "" }]);
		}
		case "search": {
			const bad = onlyKeys(p, ["query"]);
			if (bad) return refuse(bad);
			if (typeof p.query !== "string") return refuse("its query must be text");
			return page?.search || declared?.search ? ok("search") : refuse("this screen has no search");
		}
		case "filter": {
			const bad = onlyKeys(p, ["filter", "values"]);
			if (bad) return refuse(bad);
			if (!strings(p.values)) return refuse("its values must be text");
			const shown = found.pages.some((pg) => pg.filters?.some((f) => f.id === p.filter));
			return shown || viewChange(declared, {}, name, p) ? ok(`filter ${quote(String(p.filter))}`) : refuse(`filter ${quote(String(p.filter))} isn't on the screen`);
		}
		case "filter-arrange": {
			const bad = onlyKeys(p, ["order", "grouped"]);
			if (bad) return refuse(bad);
			if (!strings(p.order) || !strings(p.grouped) || !p.grouped.every((g) => (p.order as string[]).includes(g))) return refuse("its order and grouped must be filter ids");
			if (declared?.arrange) return ok("filters");
			const filters = found.pages.flatMap((pg) => pg.filters ?? []);
			if (!filters.some((f) => f.group)) return refuse("this screen's filters can't be arranged");
			const ids = new Set(filters.map((f) => f.id));
			return p.order.length === ids.size && p.order.every((id) => ids.has(id)) ? ok("filters") : refuse("its order doesn't list this screen's filters");
		}
		case "sort": {
			const bad = onlyKeys(p, ["table", "key", "desc"]);
			if (bad) return refuse(bad);
			if (typeof p.key !== "string" || typeof p.desc !== "boolean") return refuse("its key must be text and desc true or false");
			const t = tableOf(found, p.table);
			const shown = t?.node.columns.some((c) => c.key === p.key && c.sortable);
			return shown || viewChange(declared, {}, name, p) ? ok(`table ${quote(String(p.table))}`) : refuse(`table ${quote(String(p.table))} can't be sorted by ${quote(p.key)}`);
		}
	}
	return null;
}

/** Ids a table's events can name a row by: its rows', and with `contextSelect`, what context rows stand for. */
function selectable(node: Table): Set<string> {
	const ids = new Set<string>();
	const walk = (rows: Row[]) => rows.forEach((r) => (ids.add(node.contextSelect && r.context !== undefined ? r.context : r.id), r.children && walk(r.children)));
	walk(node.rows);
	return ids;
}

function check(tree: Node, name: string, payload: unknown, declared?: ViewDeclaration, address?: ActionAddress): Resolved | Refused {
	const p = payload === undefined ? {} : payload;
	if (!isRecord(p)) return refuse("its payload isn't an object");
	const found = offered(tree);
	if (address) return matchAction(found, name, p, address, true);
	const builtIn = checkBuiltIn(found, name, p, declared);
	// A plugin may name an action like a built-in event ("select"): what the tree offers decides.
	if (builtIn && !isRefused(builtIn)) return builtIn;
	if (builtIn && !found.offers.some((o) => o.name === name)) return builtIn;
	return matchAction(found, name, p);
}

/**
 * Whether a person's event matches what the tree offers: an action event (named by the action id)
 * offered at that place and not disabled, or a built-in event (`field`, `select`, `reorder`,
 * `dialog-close`, `search`, `filter`, `filter-arrange`, `sort`) naming things the tree has. View
 * events the SDK applies itself pass when the view declaration covers them.
 */
export function checkEvent(tree: Node, name: string, payload: unknown, declared?: ViewDeclaration): Resolved | Refused {
	return check(tree, name, payload, declared);
}

/** Resolves an address in a tree: the event to send, and what it acts on. An action offered in several places is refused. */
export function resolve(tree: Node, address: Address, declared?: ViewDeclaration): Resolved | Refused {
	if (address.kind === "action") return check(tree, address.action, payloadFor(address), declared, address);
	return check(tree, address.kind, payloadFor(address), declared);
}

export const isRefused = (r: Resolved | Refused): r is Refused => "refused" in r;
