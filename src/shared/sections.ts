// Declared table sections and their sub-sections (capability `ui.sub-sections`). A row joins a
// sub-section with `group: "<sub id>"` (or a path starting with it); the renderer, drag and
// drop and the selection handoff all see it under its parent, as the path `[parent, sub, …]`.
import type { GroupLabel, Row, Section } from "./protocol";

/** A group level's key: its `id`, else its label. */
export const groupKey = (label: GroupLabel): string => (typeof label === "string" ? label : (label.id ?? label.label));

/** Which declared section each sub-section belongs to (sub-section id → parent section). */
export function subSectionParents(sections: Section[] | undefined): Map<string, Section> {
	const out = new Map<string, Section>();
	for (const parent of sections ?? []) for (const sub of parent.sections ?? []) out.set(sub.id, parent);
	return out;
}

/** Every declared section and sub-section, parents before their sub-sections. */
export const flatSections = (sections: Section[] | undefined): Section[] => (sections ?? []).flatMap((s) => [s, ...(s.sections ?? [])]);

/**
 * A row's group as a path from the top: a group starting with a sub-section's id gets its
 * parent in front (`"snoozed"` → `["progressing", "snoozed"]`). Other groups are unchanged.
 */
export function sectionGroup(group: Row["group"], parents: Map<string, Section>): GroupLabel[] {
	const path = group === undefined ? [] : typeof group === "string" ? [group] : group;
	const parent = path.length ? parents.get(groupKey(path[0]!)) : undefined;
	return parent ? [parent.id, ...path] : path;
}

/** How many leading levels of a path (from `sectionGroup`) name declared sections: 2 inside a sub-section. */
export function sectionDepth(path: GroupLabel[], parents: Map<string, Section>): number {
	if (!path.length) return 0;
	return path.length > 1 && parents.get(groupKey(path[1]!))?.id === groupKey(path[0]!) ? 2 : 1;
}
