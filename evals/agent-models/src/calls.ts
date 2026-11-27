// Prints each conversation's tool calls (arguments, size, errors) and answers from a results folder,
// for reading how models use the tools without opening report.html.
// bun src/calls.ts <results dir> [--case id] [--candidate substring] [--errors]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CaseRun } from "./agent";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { case: { type: "string" }, candidate: { type: "string" }, errors: { type: "boolean" } } });
const runs = readFileSync(join(positionals[0], "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CaseRun);
for (const r of runs) {
	if (values.case && r.case !== values.case) continue;
	if (values.candidate && !r.candidate.includes(values.candidate)) continue;
	const turns = r.turns.filter((t) => !values.errors || t.calls.some((c) => c.isError));
	if (!turns.length) continue;
	console.log(`\n=== ${r.candidate} · ${r.case} · ${r.pass ? "pass" : "FAIL"}`);
	for (const t of turns) {
		console.log(`> ${t.user}`);
		for (const c of t.calls) console.log(`  ${c.isError ? "✗" : "·"} ${c.name} ${JSON.stringify(c.args)} → ${c.output.length} chars${c.isError ? `: ${c.output.slice(0, 220)}` : ""}`);
		if (!values.errors) console.log(`  answer: ${t.answer.replace(/\n+/g, " ⏎ ").slice(0, 700)}`);
	}
}
