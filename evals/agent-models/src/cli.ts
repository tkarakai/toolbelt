// bun src/cli.ts <command>
//   models                         oMLX's chat models with size, context and thinking support
//   bench  [--models a,b] [--sizes 1000,8000,32000,60000]   load time, memory, prefill/decode speed by prompt size
//   run    [--models a,b:think] [--cases x,y] [--all] [--repeat n] [--out dir] [--judge provider/model]
//   report <results dir>           rebuilds report.html and summary.json from runs.jsonl
// Models are oMLX ids; append ":think" to run with thinking on. Without --models, `run` uses
// models.json's "default" list.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runCase, type CaseRun } from "./agent";
import { CASES } from "./cases";
import { bench } from "./bench";
import { judgeRuns } from "./judge";
import { isChatCandidate, omlxServer, omlxStatus, parseCandidate, startRecorder, warm } from "./omlx";
import { writeReport } from "./report";
import { setup } from "./setup";
import config from "../models.json";

const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		models: { type: "string" },
		cases: { type: "string" },
		all: { type: "boolean", default: false },
		repeat: { type: "string", default: "1" },
		out: { type: "string" },
		judge: { type: "string" },
		sizes: { type: "string" },
		"max-turns": { type: "string", default: "12" },
		"timeout": { type: "string", default: "600" },
		"max-output": { type: "string", default: "8192" },
	},
});
const [command, ...rest] = positionals;
const RESULTS = join(import.meta.dir, "../results");

const gb = (n: number | null | undefined) => (n ? `${(n / 1e9).toFixed(1)} GB` : "-");
const k = (n: number | null | undefined) => (n ? `${Math.round(n / 1000)}k` : "-");

if (command === "models") {
	const s = await omlxStatus();
	console.log(`memory ceiling ${gb(s.final_ceiling)}, loaded now ${gb(s.current_model_memory)}\n`);
	console.log(["model", "size", "context (allowed/native)", "max out", "thinking", "type"].join("\t"));
	for (const m of s.models.filter(isChatCandidate))
		console.log([m.id, gb(m.estimated_size), `${k(m.max_context_window)}/${k(m.model_context_length)}`, k(m.max_tokens), (m.reasoning_levels ?? []).join("/") || "-", m.config_model_type].join("\t"));
} else if (command === "bench") {
	const ids = (values.models?.split(",") ?? config.default).map((s) => parseCandidate(s).model);
	const out = values.out ?? join(RESULTS, `bench-${stamp()}`);
	mkdirSync(out, { recursive: true });
	await bench([...new Set(ids)], out, values.sizes?.split(",").map(Number));
} else if (command === "run") {
	await setup();
	const status = await omlxStatus();
	const candidates = (values.models?.split(",") ?? config.default).map(parseCandidate);
	for (const cand of candidates) if (!status.models.some((m) => m.id === cand.model)) throw new Error(`oMLX has no model ${cand.model} (see: bun src/cli.ts models)`);
	const ids = values.cases?.split(",");
	const cases = CASES.filter((c) => (ids ? ids.includes(c.id) : values.all || !c.slow));
	if (!cases.length) throw new Error(`no cases match ${values.cases}`);
	const repeat = Number(values.repeat);
	const out = values.out ?? join(RESULTS, stamp());
	mkdirSync(out, { recursive: true });
	const server = await omlxServer();
	writeFileSync(
		join(out, "meta.json"),
		JSON.stringify({ startedAt: new Date().toISOString(), omlx: server.version, candidates, cases: cases.map((c) => c.id), repeat, options: values, models: status.models.filter((m) => candidates.some((c) => c.model === m.id)) }, null, "\t"),
	);
	const recorder = startRecorder();
	const runsFile = join(out, "runs.jsonl");
	console.log(`results: ${out}`);
	for (const cand of candidates) {
		const om = status.models.find((m) => m.id === cand.model)!;
		const loadMs = await warm(om.id).catch((e) => (console.error(String(e)), -1));
		const after = (await omlxStatus()).models.find((m) => m.id === om.id);
		appendFileSync(join(out, "loads.jsonl"), JSON.stringify({ model: om.id, loadMs, actualSize: after?.actual_size ?? null, estimatedSize: om.estimated_size }) + "\n");
		console.log(`\n${cand.id}: loaded in ${(loadMs / 1000).toFixed(1)} s, ${gb(after?.actual_size ?? om.estimated_size)}`);
		for (let r = 0; r < repeat; r++)
			for (const c of cases) {
				const run: CaseRun & { repeat: number } = {
					...(await runCase(c, cand, om, { maxTurns: Number(values["max-turns"]), turnTimeoutMs: Number(values.timeout) * 1000, maxOutput: Number(values["max-output"]), recorder })),
					repeat: r,
				};
				appendFileSync(runsFile, JSON.stringify(run) + "\n");
				const failed = run.turns.flatMap((t) => t.checks.filter((x) => !x.pass).map((x) => `${x.label}${x.detail ? ` (${x.detail})` : ""}`));
				console.log(`  ${run.pass ? "PASS" : "FAIL"} ${c.id.padEnd(18)} ${(run.score * 100).toFixed(0).padStart(3)}%  ${(run.ms / 1000).toFixed(0).padStart(4)} s  ${run.error ?? failed.join("; ")}`);
			}
	}
	recorder.stop();
	if (values.judge) await judgeRuns(out, values.judge);
	writeReport(out);
	console.log(`\nreport: ${join(out, "report.html")}`);
} else if (command === "report") {
	const dir = rest[0];
	if (!dir || !existsSync(join(dir, "runs.jsonl"))) throw new Error("usage: report <results dir with runs.jsonl>");
	if (values.judge) await judgeRuns(dir, values.judge);
	writeReport(dir);
	console.log(join(dir, "report.html"));
} else {
	console.log(readFileSync(import.meta.path, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
}

function stamp() {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
process.exit(0);
