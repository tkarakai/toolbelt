// Lucide icons by kebab-case name. `icons` holds only the canonical names, so names Lucide has
// renamed or aliased ("history", "trash-2", "edit") are looked up among its named exports too,
// limited to exports that are icons.
import * as lucide from "lucide-react";
import { icons, type LucideIcon } from "lucide-react";

const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
const known = new Set<unknown>(Object.values(icons));

/** The Lucide icon a kebab-case name refers to, by its current name or an alias; null if none. */
export function lucideIcon(name: string | undefined): LucideIcon | null {
	if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return null;
	const key = pascal(name);
	if (Object.hasOwn(icons, key)) return icons[key as keyof typeof icons];
	if (key.endsWith("Icon") || key.startsWith("Lucide")) return null;
	const alias = Object.hasOwn(lucide, key) ? (lucide as Record<string, unknown>)[key] : undefined;
	return known.has(alias) ? (alias as LucideIcon) : null;
}
