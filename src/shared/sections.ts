// Declared table sections and the sections nested in them: sub-sections (capability
// `ui.sub-sections`, one level) and deeper levels (capability `ui.nested-sections`, up to
// `MAX_SECTION_DEPTH`). A row joins a nested section with `group: "<id>"` (or a path starting
// with it); the renderer, drag and drop and the selection handoff all see it under its
// ancestors, as the path `[top, …, id, …]`.
import { MAX_SECTION_DEPTH, type GroupLabel, type Row, type Section } from "./protocol";

export { MAX_SECTION_DEPTH };

/** A group level's key: its `id`, else its label. */
export const groupKey = (label: GroupLabel): string => (typeof label === "string" ? label : (label.id ?? label.label));

/** Each declared section's ancestors, outermost first (empty for a top-level section). */
export function sectionAncestors(sections: Section[] | undefined): Map<string, Section[]> {
	const out = new Map<string, Section[]>();
	const visit = (list: Section[], above: Section[]) => {
		for (const s of list) {
			out.set(s.id, above);
			if (s.sections) visit(s.sections, [...above, s]);
		}
	};
	visit(sections ?? [], []);
	return out;
}

/** Every declared section at any depth, each before the sections nested in it. */
export const flatSections = (sections: Section[] | undefined): Section[] => (sections ?? []).flatMap((s) => [s, ...flatSections(s.sections)]);


/**
 * A row's group as a path from the top: a group starting with a nested section's id gets that
 * section's ancestors in front (`"snoozed"` → `["progressing", "snoozed"]`). Other groups are
 * unchanged.
 */
export function sectionGroup(group: Row["group"], ancestors: Map<string, Section[]>): GroupLabel[] {
	const path = group === undefined ? [] : typeof group === "string" ? [group] : group;
	const above = path.length ? ancestors.get(groupKey(path[0]!)) : undefined;
	return above?.length ? [...above.map((s) => s.id), ...path] : path;
}

/**
 * How many leading levels of a path (from `sectionGroup`) name declared sections: the top
 * level, then each level that is declared inside the one before it.
 */
export function sectionDepth(path: GroupLabel[], ancestors: Map<string, Section[]>): number {
	if (!path.length) return 0;
	let depth = 1;
	while (depth < path.length) {
		const above = ancestors.get(groupKey(path[depth]!));
		if (!above || above.length !== depth || above.some((s, i) => s.id !== groupKey(path[i]!))) break;
		depth++;
	}
	return depth;
}
