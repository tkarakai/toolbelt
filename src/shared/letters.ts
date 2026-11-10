// One-letter shortcuts for the tools in the menu bar popover: `p` for Processes, `u` for
// Upkeep. Each tool gets the first letter of its name that's still free, else another
// letter of its name, else any free letter — in list order, so the first tools keep theirs.

/** Tool id → its lowercase letter. Tools left without one (more than 26) are missing. */
export function assignLetters(tools: { id: string; name: string }[]): Map<string, string> {
	const taken = new Set<string>();
	const out = new Map<string, string>();
	const letters = (s: string) => [...s.toLowerCase()].filter((c) => c >= "a" && c <= "z");
	const all = [..."abcdefghijklmnopqrstuvwxyz"];
	for (const t of tools) {
		const name = letters(t.name);
		// Word starts first ("Port Scanner" → p, then s), then the rest of the name, then anything.
		const starts = t.name.split(/[^a-zA-Z]+/).flatMap((w) => letters(w).slice(0, 1));
		const pick = [...starts, ...name, ...all].find((c) => !taken.has(c));
		if (!pick) continue;
		taken.add(pick);
		out.set(t.id, pick);
	}
	return out;
}
