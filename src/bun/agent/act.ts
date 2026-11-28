// Agents acting (docs/agent-interface.md, "Acting"): pure helpers over a plugin tree. Which action or
// form an agent's names point to (`pickAction`, `pickForm`), field values in the shape each type
// takes (`coerce`), a dialog's current values for the approval, and what changed between two
// renders of the agent's acting instance (`changes`). No host state; the core runs them.
import { fieldValueFits, offerings, type FieldOffering, type Offering } from "../../shared/actions";
import { HUES, type Field, type Node, type Row, type Section } from "../../shared/protocol";
import { labelled } from "./names";
import { cellText, fieldText, fillable, fieldKind, oneLine, redact, type Declared } from "./serialize";

/** Why a pick failed: the message for the agent, a fixed reason for the audit log (no text). */
export type Refusal = { refused: string; reason: string };
/** The row isn't in the tree: the caller explains which part of the view hides it. */
export type MissingRow = { missingRow: string };

const norm = (s: string) => s.trim().toLowerCase();
const quote = (s: string) => JSON.stringify(s.length > 64 ? `${s.slice(0, 63)}…` : s);
const list = (names: string[]) => (names.length ? names.join(", ") : "none");

/** Offer kinds agents act through: screens only (no floating window or suggestions). */
const ON_SCREENS = (o: Offering) => o.kind !== "floating" && o.kind !== "suggestion";
/** Whether agents may run an action id: not declared `agent: false`. */
export const forAgents = (declared: Declared, id: string) => !Object.hasOwn(declared.actions, id) || declared.actions[id].agent !== false;
/** Whether agents may fill a form: declared, and not `agent: false`. */
export const formForAgents = (declared: Declared, id: string) => Object.hasOwn(declared.forms, id) && declared.forms[id].agent !== false;

/** Every row and list item id in a tree. */
export function rowIds(tree: unknown, ids = new Set<string>()): Set<string> {
	if (Array.isArray(tree)) for (const v of tree) rowIds(v, ids);
	else if (tree && typeof tree === "object") {
		const o = tree as Record<string, unknown>;
		const rows = (list: Row[]) => list.forEach((r) => (ids.add(r.id), r.children && rows(r.children)));
		if (o.type === "table" && Array.isArray(o.rows)) rows(o.rows as Row[]);
		if (o.type === "list" && Array.isArray(o.items)) for (const i of o.items as { id: string }[]) ids.add(i.id);
		for (const v of Object.values(o)) if (v && typeof v === "object") rowIds(v, ids);
	}
	return ids;
}

/** The open dialog of a page tree, if any. */
export const openDialog = (tree: Node) => (tree.type === "page" ? (tree.dialog ?? null) : null);

export type ActionInput = { action: string; row?: string; rows?: string[]; table?: string; dialog?: string; target?: string; text?: string };
export type Picked = {
	offering: Offering;
	/** The event's payload: the renderer's, with `rowIds`, `target` and `text` where given. */
	payload: Record<string, unknown>;
	rows: { id: string; title: string }[];
	/** How names were read ("action "settle" for "Settle""). */
	notes: string[];
};

/**
 * The action an agent names, where it's offered in the tree: by id, else by id or label ignoring
 * case (a label two actions share is refused with their ids). `rows` addresses bulk actions,
 * `row` row actions (and a bulk action on that one row); without rows, an open dialog is searched
 * first, then the page and its cards. An action offered in several places is refused with them.
 */
export function pickAction(tree: Node, declared: Declared, input: ActionInput): Picked | Refusal | MissingRow {
	const all = offerings(tree).actions.filter(ON_SCREENS);
	const hidden = all.filter((o) => !forAgents(declared, o.name));
	const offered = all.filter((o) => forAgents(declared, o.name));
	const notes: string[] = [];
	const wanted = input.action;
	const labelOf = (id: string) => offered.find((o) => o.name === id)?.action.label ?? id;
	let name: string;
	if (offered.some((o) => o.name === wanted)) name = wanted;
	else {
		const ids = [...new Set(offered.filter((o) => norm(o.name) === norm(wanted) || norm(o.action.label) === norm(wanted)).map((o) => o.name))];
		if (ids.length > 1) return { refused: `${quote(wanted)} names more than one action: ${ids.map((id) => labelled(labelOf(id), id)).join(", ")}. Pass the id in brackets.`, reason: "ambiguous action" };
		if (!ids.length) {
			if (hidden.some((o) => o.name === wanted || norm(o.name) === norm(wanted) || norm(o.action.label) === norm(wanted)))
				return { refused: `${quote(wanted)} isn't offered to agents: the plugin keeps it for the person. Nothing was done.`, reason: "not offered to agents" };
			const names = [...new Set(offered.filter((o) => !o.action.disabled).map((o) => labelled(o.action.label, o.name)))];
			return { refused: `This screen offers no action ${quote(wanted)}${input.row ? ` (or not for row ${quote(input.row)})` : ""}. Actions here: ${list(names.slice(0, 30))}. Nothing was done.`, reason: "unknown action" };
		}
		name = ids[0];
		// A name that differs only in case needs no note.
		if (norm(name) !== norm(wanted)) notes.push(`action ${quote(name)} for ${quote(wanted)}`);
	}
	let named = offered.filter((o) => o.name === name);
	const label = labelOf(name);
	const what = labelled(label, name);
	if (input.table !== undefined) {
		named = named.filter((o) => o.table === input.table || o.list === input.table);
		if (!named.length) return { refused: `${what} isn't offered in table ${quote(input.table)}. Nothing was done.`, reason: "not offered there" };
	}
	const present = rowIds(tree);
	let candidates: Offering[];
	let bulkRows: string[] | null = null;
	if (input.rows) {
		candidates = named.filter((o) => o.kind === "bulk");
		// One row and no bulk action: the row's own action.
		if (!candidates.length && input.rows.length === 1) return pickAction(tree, declared, { ...input, rows: undefined, row: input.rows[0] });
		if (!candidates.length) return { refused: `${what} isn't a bulk action here: pass one row as row.${named.some((o) => o.rows.length) ? "" : " It acts on no rows."} Nothing was done.`, reason: "not a bulk action" };
		const missing = input.rows.find((id) => !present.has(id));
		if (missing !== undefined) return { missingRow: missing };
		candidates = candidates.filter((o) => input.rows!.every((id) => o.bulk?.has(id)));
		if (!candidates.length) return { refused: `${what} can't act on all of those rows together (they're in different tables, or the bulk action doesn't cover them). Nothing was done.`, reason: "rows not in one table" };
		bulkRows = input.rows;
	} else if (input.row !== undefined) {
		candidates = named.filter((o) => o.kind !== "bulk" && o.rows[0]?.id === input.row);
		if (!candidates.length) {
			const bulk = named.filter((o) => o.kind === "bulk" && o.bulk?.has(input.row!));
			if (bulk.length) {
				candidates = bulk;
				bulkRows = [input.row];
			}
		}
		if (!candidates.length) {
			if (!present.has(input.row)) return { missingRow: input.row };
			const mine = [...new Set(offered.filter((o) => !o.action.disabled && o.rows[0]?.id === input.row && o.kind !== "bulk").map((o) => labelled(o.action.label, o.name)))];
			return { refused: `${what} isn't offered for row ${quote(input.row)}. Its actions: ${list(mine)}. Nothing was done.`, reason: "not offered for that row" };
		}
	} else {
		const loose = named.filter((o) => o.kind !== "bulk" && !o.rows.length);
		const dialog = openDialog(tree);
		if (input.dialog !== undefined) {
			if (dialog?.id !== input.dialog) return { refused: `No dialog ${quote(input.dialog)} is open in your acting copy${dialog ? ` (dialog ${quote(dialog.id)} is)` : ""}. Nothing was done.`, reason: "dialog not open" };
			candidates = loose.filter((o) => o.dialog === input.dialog);
		} else {
			const inDialog = loose.filter((o) => o.dialog !== undefined);
			candidates = inDialog.length ? inDialog : loose;
		}
		if (!candidates.length) {
			if (named.some((o) => o.kind === "bulk")) return { refused: `${what} acts on rows: pass rows (or row) with their ids. Nothing was done.`, reason: "needs rows" };
			if (named.some((o) => o.rows.length)) return { refused: `${what} acts on a row: pass row with its id (as read_screen shows it in {id: …}). Nothing was done.`, reason: "needs a row" };
			return { refused: `${what} isn't offered ${input.dialog !== undefined ? "in that dialog" : "there"}. Nothing was done.`, reason: "not offered there" };
		}
	}
	const enabled = candidates.filter((o) => !o.action.disabled);
	if (!enabled.length) return { refused: `${what} is disabled right now (${candidates[0].place}). Nothing was done.`, reason: "disabled" };
	// The same action twice in one place (a row menu and an inline button) is one place.
	const places = [...new Map(enabled.map((o) => [`${o.place}\n${JSON.stringify(o.payload)}`, o])).values()];
	if (places.length > 1)
		return {
			refused: `${what} is offered in several places: ${places.slice(0, 6).map((o) => o.place).join("; ")}. Pass ${places.some((o) => o.dialog) ? "dialog" : "table"} to pick one. Nothing was done.`,
			reason: "offered in several places",
		};
	const o = places[0];
	if (input.target !== undefined && !o.targets.includes(input.target))
		return { refused: `${what} has no target ${quote(input.target)}.${o.targets.length ? ` Its targets: ${o.targets.join(", ")}.` : " It takes none."} Nothing was done.`, reason: "unknown target" };
	if (o.text && !(typeof input.text === "string" && input.text.trim())) return { refused: `${what} needs text: pass text. Nothing was done.`, reason: "needs text" };
	if (!o.text && input.text !== undefined) return { refused: `${what} takes no text. Nothing was done.`, reason: "takes no text" };
	const payload: Record<string, unknown> = { ...o.payload, ...(bulkRows ? { rowIds: bulkRows } : {}), ...(input.target !== undefined ? { target: input.target } : {}), ...(o.text ? { text: input.text } : {}) };
	const rows = bulkRows ? bulkRows.map((id) => ({ id, title: o.bulk?.get(id) ?? "" })) : o.rows;
	return { offering: o, payload, rows, notes };
}

/** A form's fields with their values as the person reads them (sensitive and secret values masked). */
export function formValues(fields: Field[], now: number) {
	return fields.map((f) => ({ label: f.label || f.id, value: oneLine(fieldText(f, now)).trim() }));
}

/** The open dialog's title and its forms' current values, for the approval of its action. */
export function dialogValues(tree: Node, dialog: string, now: number): { title: string; values: { label: string; value: string }[] } | null {
	const d = openDialog(tree);
	if (!d || d.id !== dialog) return null;
	const fields: Field[] = [];
	const walk = (n: unknown): void => {
		if (Array.isArray(n)) return n.forEach(walk);
		if (!n || typeof n !== "object") return;
		const o = n as { type?: string; fields?: Field[] };
		if (o.type === "form" && Array.isArray(o.fields)) fields.push(...o.fields);
		else for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
	};
	walk(d.children);
	return { title: d.title, values: formValues(fields, now) };
}

/** A value from an agent in the shape `field` takes: options by value or label, switches from words, tags from "Key: value". */
export function coerce(field: Field, raw: unknown): { value: unknown } | { refused: string } {
	const name = labelled(field.label || field.id, field.id);
	const fits = (value: unknown) => (fieldValueFits(field, value) ? { value } : { refused: `${name} takes ${fieldKind(field)}; ${JSON.stringify(raw)} doesn't fit.` });
	const text = typeof raw === "number" || typeof raw === "boolean" ? String(raw) : raw;
	switch (field.type) {
		case "select":
		case "combobox": {
			if (typeof text !== "string") return fits(raw);
			if (field.options.some((o) => o.value === text)) return { value: text };
			const matches = field.options.filter((o) => norm(o.value) === norm(text) || norm(o.label) === norm(text));
			if (matches.length === 1) return { value: matches[0].value };
			if (matches.length > 1) return { refused: `${JSON.stringify(text)} names more than one option of ${name}: ${matches.map((o) => labelled(o.label, o.value)).join(", ")}. Pass the value in brackets.` };
			if (field.type === "combobox" && field.freeform) return { value: text };
			return { refused: `${name} has no option ${JSON.stringify(text)}. Its options: ${field.options.map((o) => labelled(o.label, o.value)).join(", ")}.` };
		}
		case "switch": {
			if (typeof raw === "boolean") return { value: raw };
			const word = typeof raw === "string" ? norm(raw) : "";
			if (["true", "on", "yes", "1"].includes(word)) return { value: true };
			if (["false", "off", "no", "0"].includes(word)) return { value: false };
			return fits(raw);
		}
		case "duration": {
			if (raw === null || (typeof raw === "string" && ["none", "null", ""].includes(norm(raw)))) return fits(null);
			const n = typeof raw === "string" ? Number(raw) : raw;
			return typeof n === "number" && Number.isFinite(n) ? fits(Math.round(n)) : fits(raw);
		}
		case "color": {
			const hue = typeof text === "string" ? HUES.find((h) => h === norm(text)) : undefined;
			return hue ? { value: hue } : { refused: `${name} takes one of: ${HUES.join(", ")}.` };
		}
		case "tags": {
			const items = typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(raw) ? raw : null;
			if (!items) return fits(raw);
			const out: { key: string; value?: string }[] = [];
			for (const item of items) {
				let keyName: string;
				let value: string | undefined;
				if (typeof item === "string") {
					const at = item.indexOf(":");
					keyName = at < 0 ? item : item.slice(0, at).trim();
					value = at < 0 ? undefined : item.slice(at + 1).trim();
				} else if (item && typeof item === "object" && typeof (item as { key?: unknown }).key === "string") {
					keyName = (item as { key: string }).key;
					const v = (item as { value?: unknown }).value;
					value = typeof v === "string" ? v : undefined;
				} else return fits(raw);
				const key = field.keys.find((k) => k.key === keyName) ?? field.keys.find((k) => norm(k.key) === norm(keyName) || norm(k.label) === norm(keyName));
				if (!key) return { refused: `${name} has no tag ${JSON.stringify(keyName)}. Its tags: ${field.keys.map((k) => labelled(k.label, k.key)).join(", ")}.` };
				if (key.flag) out.push({ key: key.key });
				else {
					if (value === undefined || value === "") return { refused: `Tag ${labelled(key.label, key.key)} of ${name} needs a value ("${key.label}: value").` };
					const known = key.values?.find((v) => v === value) ?? key.values?.find((v) => norm(v) === norm(value!));
					if (key.values?.length && !known && !key.freeform) return { refused: `Tag ${labelled(key.label, key.key)} of ${name} has no value ${JSON.stringify(value)}. Its values: ${key.values.join(", ")}.` };
					out.push({ key: key.key, value: known ?? value });
				}
			}
			return fits(out);
		}
		case "options": {
			const items = typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : raw;
			return fits(Array.isArray(items) ? items.map((i) => (typeof i === "string" ? { text: i } : i)) : items);
		}
		case "environment": {
			if (typeof raw === "string")
				try {
					return fits(JSON.parse(raw));
				} catch {
					return fits(raw);
				}
			return fits(raw);
		}
		default:
			return fits(text);
	}
}

export type FormInput = { form: string; row?: string; values: Record<string, unknown> };
export type PickedForm = {
	form: string;
	/** The form's title, else its id. */
	title: string;
	row?: { id: string; title: string };
	dialog?: string;
	/** One field event per value, in the order given. */
	entries: { field: Field; label: string; value: unknown; shown: string; payload: Record<string, unknown> }[];
	notes: string[];
};

/**
 * The form and fields an agent names, by id or label ignoring case, with each value checked and
 * put in its field's shape before anything is sent. A form in a row's drawer needs `row`. Page
 * controls are view state, not forms; secret and sensitive fields aren't offered to agents.
 */
export function pickForm(tree: Node, declared: Declared, input: FormInput, now: number): PickedForm | Refusal | MissingRow {
	const fields = offerings(tree).fields.filter((f): f is FieldOffering & { field: Field } => !f.control);
	const notes: string[] = [];
	const forms = [...new Map(fields.map((f) => [`${f.form}\n${f.row ?? ""}`, f])).values()];
	// A dialog's untitled form goes by the dialog's title.
	const dialog = openDialog(tree);
	const titleOf = (f: FieldOffering) => f.title ?? (f.dialog !== undefined && dialog?.id === f.dialog ? dialog.title : f.form);
	const at = forms.filter((f) => (input.row === undefined ? f.row === undefined : f.row === input.row));
	const fillableForms = (list: FieldOffering[]) => list.filter((f) => formForAgents(declared, f.form));
	let chosen = at.find((f) => f.form === input.form);
	if (!chosen) {
		const ids = [...new Set(at.filter((f) => norm(f.form) === norm(input.form) || norm(titleOf(f)) === norm(input.form)).map((f) => f.form))];
		if (ids.length > 1) return { refused: `${quote(input.form)} names more than one form: ${ids.map((id) => labelled(titleOf(at.find((f) => f.form === id)!), id)).join(", ")}. Pass the id in brackets.`, reason: "ambiguous form" };
		if (ids.length === 1) {
			chosen = at.find((f) => f.form === ids[0]);
			if (norm(ids[0]) !== norm(input.form)) notes.push(`form ${quote(ids[0])} for ${quote(input.form)}`);
		}
	}
	if (!chosen) {
		const elsewhere = forms.find((f) => f.form === input.form || norm(f.form) === norm(input.form) || norm(titleOf(f)) === norm(input.form));
		if (input.row === undefined && elsewhere?.row !== undefined) return { refused: `Form ${quote(input.form)} is in each row's drawer: pass row with the row's id. Nothing was done.`, reason: "needs a row" };
		if (input.row !== undefined && !rowIds(tree).has(input.row)) return { missingRow: input.row };
		const names = fillableForms(at).map((f) => labelled(titleOf(f), f.form));
		return {
			refused: `${input.row !== undefined ? `Row ${quote(input.row)}'s drawer has` : "This screen has"} no form ${quote(input.form)} agents can fill.${names.length ? ` Forms here: ${names.join(", ")}.` : ""} Nothing was done.`,
			reason: "unknown form",
		};
	}
	if (!formForAgents(declared, chosen.form)) return { refused: `Form ${quote(chosen.form)} isn't offered to agents: the plugin keeps it for the person. Nothing was done.`, reason: "not offered to agents" };
	const own = fields.filter((f) => f.form === chosen!.form && f.row === chosen!.row);
	const entries: PickedForm["entries"] = [];
	const keys = Object.keys(input.values);
	if (!keys.length) return { refused: "values is empty: give at least one field and its value. Nothing was done.", reason: "no values" };
	for (const key of keys) {
		let spot = own.find((f) => f.field.id === key);
		if (!spot) {
			const matches = own.filter((f) => norm(f.field.id) === norm(key) || (f.field.label && norm(f.field.label) === norm(key)));
			if (matches.length > 1) return { refused: `${quote(key)} names more than one field: ${matches.map((f) => labelled(f.field.label || f.field.id, f.field.id)).join(", ")}. Pass the id in brackets. Nothing was done.`, reason: "ambiguous field" };
			spot = matches[0];
			if (spot && norm(spot.field.id) !== norm(key)) notes.push(`field ${quote(spot.field.id)} for ${quote(key)}`);
		}
		if (!spot) return { refused: `Form ${quote(chosen.form)} has no field ${quote(key)}. Its fields: ${own.filter((f) => fillable(f.field)).map((f) => labelled(f.field.label || f.field.id, f.field.id)).join(", ")}. Nothing was done.`, reason: "unknown field" };
		if (!fillable(spot.field)) return { refused: `${labelled(spot.field.label || spot.field.id, spot.field.id)} is a secret or sensitive field: agents can't fill it. Ask the person to. Nothing was done.`, reason: "secret field" };
		if (entries.some((e) => e.field.id === spot!.field.id)) return { refused: `Two keys name the field ${quote(spot.field.id)}; pass it once. Nothing was done.`, reason: "field named twice" };
		const coerced = coerce(spot.field, input.values[key]);
		if ("refused" in coerced) return { refused: `${coerced.refused} Nothing was done.`, reason: "value doesn't fit" };
		const field = spot.field;
		const shown = oneLine(fieldText({ ...field, value: coerced.value } as Field, now)).trim();
		// An option named by its label reads as its value.
		if ((field.type === "select" || field.type === "combobox") && typeof input.values[key] === "string" && norm(String(coerced.value)) !== norm(input.values[key] as string))
			notes.push(`${quote(field.id)}: ${JSON.stringify(coerced.value)} for ${JSON.stringify(input.values[key])}`);
		entries.push({ field, label: field.label || field.id, value: coerced.value, shown, payload: { form: chosen.form, field: field.id, value: coerced.value, ...(chosen.row !== undefined ? { rowId: chosen.row } : {}) } });
	}
	const rowTitle = chosen.row !== undefined ? rowTitleIn(tree, chosen.row) : "";
	return {
		form: chosen.form,
		title: titleOf(chosen),
		...(chosen.row !== undefined ? { row: { id: chosen.row, title: rowTitle } } : {}),
		...(chosen.dialog !== undefined ? { dialog: chosen.dialog } : {}),
		entries,
		notes,
	};
}

/** A row's title (its first cell's text), or a list item's. */
function rowTitleIn(tree: Node, id: string): string {
	let title = "";
	const walk = (n: unknown): void => {
		if (title || !n || typeof n !== "object") return;
		if (Array.isArray(n)) return n.forEach(walk);
		const o = n as Record<string, unknown>;
		if (o.type === "table" && Array.isArray(o.rows)) {
			const key = (o.columns as { key: string }[] | undefined)?.[0]?.key;
			const find = (rows: Row[]): void => rows.forEach((r) => (r.id === id && !title ? (title = key ? cellText(r.cells[key], 0, false) : id) : r.children && find(r.children)));
			find(o.rows as Row[]);
		}
		if (o.type === "list" && Array.isArray(o.items)) for (const i of o.items as { id: string; title: string }[]) if (i.id === id) title = i.title;
		for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
	};
	walk(tree);
	return title;
}

// ── What changed between two renders ────────────────────────────────────

type Seen = { line: string; where: string };

/** Section labels of a table by id, sub-sections as "Upcoming › This week". */
function sectionLabels(sections: Section[] | undefined, parent = "", map = new Map<string, string>()) {
	for (const s of sections ?? []) {
		const label = parent && parent !== s.label ? `${parent} › ${s.label}` : s.label;
		map.set(s.id, label);
		sectionLabels(s.sections, label, map);
	}
	return map;
}

/** Every row, list item and form field of a tree, as lines in the serializer's format. */
function inventory(tree: Node, now: number) {
	const rows = new Map<string, Seen>();
	const fields = new Map<string, Seen & { label: string; form: string }>();
	const walk = (n: unknown, pane?: string): void => {
		if (!n || typeof n !== "object") return;
		if (Array.isArray(n)) return n.forEach((c) => walk(c, pane));
		const o = n as Record<string, unknown>;
		if (o.type === "table" && Array.isArray(o.rows)) {
			const t = o as Extract<Node, { type: "table" }>;
			const labels = sectionLabels(t.sections);
			const visit = (r: Row) => {
				const cells = t.columns.map((c) => cellText(r.cells[c.key], now, false)).filter(Boolean);
				const group = r.group === undefined ? "" : typeof r.group === "string" ? r.group : r.group.map((g) => (typeof g === "string" ? g : (g.id ?? g.label))).join(" › ");
				const where = group ? (labels.get(group) ?? (typeof r.group === "string" ? group : (r.group as unknown[]).map((g) => (typeof g === "string" ? (labels.get(g) ?? g) : (g as { label: string }).label)).join(" › "))) : "";
				rows.set(`${t.id}\n${r.id}`, { line: `${cells.join(" · ")}  {id: ${r.id}}`, where });
				if (r.pane) walk(r.pane, r.id);
				r.children?.forEach(visit);
			};
			t.rows.forEach(visit);
			return;
		}
		if (o.type === "list" && Array.isArray(o.items)) {
			const l = o as Extract<Node, { type: "list" }>;
			for (const i of l.items) rows.set(`${l.id}\n${i.id}`, { line: `${oneLine(i.title)}${i.subtitle ? ` — ${oneLine(i.subtitle)}` : ""}  {id: ${i.id}}`, where: "" });
			return;
		}
		if (o.type === "form" && Array.isArray(o.fields)) {
			const f = o as Extract<Node, { type: "form" }>;
			for (const field of f.fields)
				fields.set(`${f.id}\n${pane ?? ""}\n${field.id}`, { line: oneLine(fieldText(field, now)).trim(), where: pane ?? "", label: field.label || field.id, form: f.id });
			return;
		}
		for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, pane);
	};
	walk(tree);
	return { rows, fields, dialog: openDialog(tree)?.title ?? null, summary: tree.type === "page" ? (tree.summary ?? "") : "" };
}

/** At most this many lines of changes in a result, then a pointer to read the screen. */
export const CHANGE_LINES = 40;

/**
 * What changed between two renders of an instance, in the serializer's row format: rows added,
 * removed and changed (with the section a row moved between), field values, the summary and a
 * dialog opened or closed. Secret and sensitive values stay masked. At most `CHANGE_LINES` lines.
 */
export function changes(before: Node, after: Node, now: number): { lines: string[]; more: number } {
	const a = inventory(redact(before), now);
	const b = inventory(redact(after), now);
	const lines: string[] = [];
	if (a.dialog !== b.dialog) {
		if (a.dialog && b.dialog) lines.push(`Dialog "${a.dialog}" closed and "${b.dialog}" opened.`);
		else lines.push(b.dialog ? `Dialog "${b.dialog}" opened.` : `Dialog "${a.dialog}" closed.`);
	}
	if (a.summary !== b.summary && b.summary) lines.push(`Summary: ${b.summary} (was: ${a.summary || "none"})`);
	for (const [key, row] of b.rows) {
		const was = a.rows.get(key);
		if (!was) lines.push(`+ added: ${row.line}${row.where ? ` (in ${row.where})` : ""}`);
		else if (was.line !== row.line || was.where !== row.where)
			lines.push(`~ ${row.line}${was.where !== row.where ? ` (moved from ${was.where || "no section"} to ${row.where || "no section"})` : ""}${was.line !== row.line ? ` (was: ${was.line})` : ""}`);
	}
	for (const [key, row] of a.rows) if (!b.rows.has(key)) lines.push(`- removed: ${row.line}${row.where ? ` (from ${row.where})` : ""}`);
	for (const [key, field] of b.fields) {
		const was = a.fields.get(key);
		if (was && was.line !== field.line) lines.push(`~ field ${field.label} [${key.split("\n")[2]}] of form ${field.form}${field.where ? ` (row ${field.where})` : ""}: ${JSON.stringify(was.line)} → ${JSON.stringify(field.line)}`);
	}
	return { lines: lines.slice(0, CHANGE_LINES), more: Math.max(0, lines.length - CHANGE_LINES) };
}
