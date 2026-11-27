// Names in an agent's view (docs/agent-interface.md, "Its own view"): a filter, control or column
// can be named by its id or by its label, and an option by its value or by its label, ignoring
// case. A filter and its values are read together: of every filter the key could name, the ones
// offering every value fit. One fit is used; when several fit, an exact id wins; otherwise the
// call is refused with the candidates. Exact ids and values always keep their meaning.

/** A filter or page control: its id, label and options (null until the screen has rendered). */
export type Named = { id: string; label: string; options: { value: string; label: string }[] | null };
/** What a screen's view controls are called: from its declaration and latest tree. */
export type ViewNames = {
	filters: Named[];
	controls: Named[];
	tables: { id: string; columns: { key: string; title: string }[] | null }[];
};
/** An agent's view object, before its names are checked. */
export type NamedView = { search?: unknown; filters?: Record<string, unknown>; sort?: Record<string, unknown>; controls?: Record<string, unknown> };

/** A name that doesn't resolve to one thing; the caller refuses it as a view refusal. */
export class NameRefusal extends Error {}

const norm = (s: string) => s.trim().toLowerCase();
const quote = (s: string) => JSON.stringify(s);

/** A label with its id when the two differ beyond case: `Workflow [workflow-state]`, `Status`. */
export const labelled = (label: string, id: string) => (norm(label) === norm(id) ? label : `${label} [${id}]`);

/** A filter or control's options as agents can name them. */
export const optionList = (options: { value: string; label: string }[]) => options.map((o) => labelled(o.label, o.value)).join(", ");

type Pick = { value: string } | { missing: true } | { ambiguous: { value: string; label: string }[] };

/** An option by value, else by value or label in any case when exactly one matches. */
function pickOption(options: { value: string; label: string }[] | null, wanted: string): Pick {
	if (!options || options.some((o) => o.value === wanted)) return { value: wanted };
	const matches = options.filter((o) => norm(o.value) === norm(wanted) || norm(o.label) === norm(wanted));
	if (matches.length === 1) return { value: matches[0].value };
	return matches.length ? { ambiguous: matches } : { missing: true };
}

/** The things a key could name: an exact id, else any id or label equal in any case. */
function candidates<T extends { id: string; label: string }>(all: T[], key: string): T[] {
	return all.filter((x) => x.id === key || norm(x.id) === norm(key) || norm(x.label) === norm(key));
}

/**
 * The view with ids and values in place of labels, and notes saying how names were read (for the
 * result's header). Keys and values that name nothing are left as they are, for the caller's
 * checks to refuse with the screen's choices.
 */
export function resolveNames(input: NamedView, names: ViewNames): { view: NamedView; notes: string[] } {
	const notes: string[] = [];
	const parts: string[] = [];
	const read: string[] = [];
	const out: NamedView = { ...input };

	if (input.filters && typeof input.filters === "object" && !Array.isArray(input.filters)) {
		const filters: Record<string, unknown> = {};
		const from = new Map<string, string>();
		for (const [key, values] of Object.entries(input.filters)) {
			const found = candidates(names.filters, key);
			const strings = Array.isArray(values) && values.every((v) => typeof v === "string") ? (values as string[]) : null;
			let chosen: Named | undefined;
			let picked: string[] | null = null;
			if (found.length && strings) {
				const readings = found.map((f) => ({ f, picks: strings.map((v) => pickOption(f.options, v)) }));
				const fits = readings.filter((r) => r.picks.every((p) => "value" in p));
				const exact = (list: typeof readings) => list.find((r) => r.f.id === key);
				const use = fits.length === 1 ? fits[0] : fits.length > 1 ? exact(fits) : (exact(readings) ?? (readings.length === 1 ? readings[0] : undefined));
				if (!use) {
					if (fits.length > 1) throw new NameRefusal(`${quote(key)} names more than one filter: ${fits.map((r) => labelled(r.f.label, r.f.id)).join(", ")}. Pass the id in brackets.`);
					throw new NameRefusal(
						`${quote(key)} could be ${readings.map((r) => labelled(r.f.label, r.f.id)).join(" or ")}, and none of them offers ${strings.map(quote).join(", ")}. ${readings.map((r) => `${labelled(r.f.label, r.f.id)}: ${r.f.options ? optionList(r.f.options) : "options unknown"}`).join("; ")}.`,
					);
				}
				const bad = use.picks.findIndex((p) => !("value" in p));
				if (bad >= 0) {
					const p = use.picks[bad];
					const name = labelled(use.f.label, use.f.id);
					if ("ambiguous" in p) throw new NameRefusal(`${quote(strings[bad])} names more than one option of ${name}: ${optionList(p.ambiguous)}. Pass the value in brackets.`);
					throw new NameRefusal(`Filter ${name} has no option ${quote(strings[bad])}. Its options: ${optionList(use.f.options ?? [])}.`);
				}
				chosen = use.f;
				picked = use.picks.map((p) => (p as { value: string }).value);
				if (fits.length > 1) {
					const others = fits.filter((r) => r !== use).map((r) => labelled(r.f.label, r.f.id));
					notes.push(`${quote(key)} is the id of ${labelled(use.f.label, use.f.id)}; ${others.join(", ")} ${others.length === 1 ? "is a different filter" : "are different filters"}.`);
				}
			} else if (found.length) {
				// Values of the wrong shape: the caller refuses them under the filter's id.
				chosen = found.find((f) => f.id === key) ?? (found.length === 1 ? found[0] : undefined);
				if (!chosen) throw new NameRefusal(`${quote(key)} names more than one filter: ${found.map((f) => labelled(f.label, f.id)).join(", ")}. Pass the id in brackets.`);
			}
			const id = chosen?.id ?? key;
			if (from.has(id)) throw new NameRefusal(`${quote(from.get(id)!)} and ${quote(key)} both name the filter ${chosen ? labelled(chosen.label, chosen.id) : quote(id)}; pass it once.`);
			from.set(id, key);
			filters[id] = picked ?? values;
			if (picked && (id !== key || picked.some((v, i) => v !== strings![i]))) read.push(`${quote(id)}: ${JSON.stringify(picked)}`);
		}
		out.filters = filters;
		if (read.length) parts.push(`filters {${read.join(", ")}}`);
	}

	if (input.controls && typeof input.controls === "object" && !Array.isArray(input.controls)) {
		const controls: Record<string, unknown> = {};
		const changed: string[] = [];
		for (const [key, value] of Object.entries(input.controls)) {
			const found = candidates(names.controls, key);
			const c = found.find((x) => x.id === key) ?? (found.length === 1 ? found[0] : undefined);
			if (!c && found.length > 1) throw new NameRefusal(`${quote(key)} names more than one control: ${found.map((x) => labelled(x.label, x.id)).join(", ")}. Pass the id in brackets.`);
			const id = c?.id ?? key;
			let v = value;
			if (c && typeof value === "string") {
				const p = pickOption(c.options, value);
				if ("ambiguous" in p) throw new NameRefusal(`${quote(value)} names more than one option of ${labelled(c.label, c.id)}: ${optionList(p.ambiguous)}. Pass the value in brackets.`);
				if ("value" in p) v = p.value;
			}
			if (Object.hasOwn(controls, id)) throw new NameRefusal(`Two keys name the control ${quote(id)}; pass it once.`);
			controls[id] = v;
			if (id !== key || v !== value) changed.push(`${quote(id)}: ${JSON.stringify(v)}`);
		}
		out.controls = controls;
		if (changed.length) parts.push(`controls {${changed.join(", ")}}`);
	}

	if (input.sort && typeof input.sort === "object" && !Array.isArray(input.sort)) {
		const sort: Record<string, unknown> = {};
		const changed: string[] = [];
		for (const [key, value] of Object.entries(input.sort)) {
			const t = names.tables.find((x) => x.id === key) ?? (names.tables.filter((x) => norm(x.id) === norm(key)).length === 1 ? names.tables.find((x) => norm(x.id) === norm(key)) : undefined);
			const id = t?.id ?? key;
			let v = value;
			if (t?.columns && typeof value === "string") {
				const desc = value.startsWith("-");
				const wanted = value.replace(/^-/, "");
				if (wanted && !t.columns.some((c) => c.key === wanted)) {
					const matches = t.columns.filter((c) => norm(c.key) === norm(wanted) || norm(c.title) === norm(wanted));
					if (matches.length > 1) throw new NameRefusal(`${quote(wanted)} names more than one column of table ${quote(id)}: ${matches.map((c) => labelled(c.title, c.key)).join(", ")}. Pass the key in brackets.`);
					if (matches.length === 1) v = `${desc ? "-" : ""}${matches[0].key}`;
				}
			}
			if (Object.hasOwn(sort, id)) throw new NameRefusal(`Two keys name the table ${quote(id)}; pass it once.`);
			sort[id] = v;
			if (id !== key || v !== value) changed.push(`${quote(id)}: ${JSON.stringify(v)}`);
		}
		out.sort = sort;
		if (changed.length) parts.push(`sort {${changed.join(", ")}}`);
	}

	return { view: out, notes: [...(parts.length ? [`Names read as: ${parts.join("; ")}.`] : []), ...notes] };
}
