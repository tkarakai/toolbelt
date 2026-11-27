// Prints what the model sees: server instructions, tool list and representative reads, with sizes.
// bun src/probe.ts [outdir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openWorld } from "./world";

const out = process.argv[2] ?? "results/probe";
mkdirSync(out, { recursive: true });
const w = await openWorld();
try {
	const save = (name: string, text: string) => {
		writeFileSync(join(out, name), text);
		console.log(`${name.padEnd(36)} ${String(text.length).padStart(7)} chars`);
	};
	save("instructions.txt", w.server.instructions);
	save("tools.json", JSON.stringify(w.tools, null, 2));
	const reads: [string, string, Record<string, unknown>][] = [
		["status.txt", "toolbelt_status", {}],
		["list_screens.txt", "list_screens", { plugin: "ontrack" }],
		["read.txt", "read_screen", { plugin: "ontrack" }],
		["read-details.txt", "read_screen", { plugin: "ontrack", details: true }],
		["read-json.txt", "read_screen", { plugin: "ontrack", format: "json" }],
		["read-rows0.txt", "read_screen", { plugin: "ontrack", max_rows: 0 }],
		["search-passport.txt", "search_screens", { query: "passport" }],
		["search-budget.txt", "search_screens", { query: "budget" }],
		["view-search-budget.txt", "read_screen", { plugin: "ontrack", view: { search: "budget" }, details: true }],
	];
	for (const [file, tool, args] of reads) {
		const r = await w.call(tool, args);
		save(file, (r.isError ? "ERROR " : "") + r.text);
	}
} finally {
	await w.stop();
}
