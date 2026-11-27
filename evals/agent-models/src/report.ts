// summary.json and a self-contained report.html for a results folder: a leaderboard per candidate
// (quality, speed, reliability, memory), a case × candidate grid, and every transcript. Decode speed
// counts only responses of 100+ tokens: oMLX overstates it for short tool-call responses.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseRun } from "./agent";
import { caseById } from "./cases";
import type { Verdict } from "./judge";

type Load = { model: string; loadMs: number; actualSize: number | null; estimatedSize: number };

const median = (xs: number[]) => {
	const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const pct = (xs: number[], p: number) => {
	const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const share = <T>(xs: T[], f: (x: T) => boolean) => (xs.length ? xs.filter(f).length / xs.length : NaN);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export type CandidateSummary = {
	candidate: string;
	model: string;
	thinking: string;
	runs: number;
	passRate: number;
	checkScore: number;
	judgeScore: number | null;
	unfaithful: number;
	turnMsMedian: number;
	turnMsP90: number;
	callsPerTurn: number;
	toolErrors: number;
	failedTurns: number;
	ttftMedian: number;
	prefillTps: number;
	decodeTps: number;
	thinkingTokensPerTurn: number;
	maxContext: number;
	/** Characters of tool output the model read per turn. */
	toolCharsPerTurn: number;
	/** Share of read_screen calls that passed a view (search, filters, sort). */
	viewReads: number;
	/** Share of read_screen calls that asked for details. */
	detailReads: number;
	/** Share of soft checks (how the agent got there) passed. */
	softScore: number;
	memory: number | null;
	loadMs: number | null;
	byArea: Record<string, number>;
};

export function summarize(runs: CaseRun[], loads: Load[], verdicts: (Verdict | null)[]): CandidateSummary[] {
	const byCand = new Map<string, { run: CaseRun; v: Verdict | null }[]>();
	runs.forEach((run, i) => byCand.set(run.candidate, [...(byCand.get(run.candidate) ?? []), { run, v: verdicts[i] ?? null }]));
	return [...byCand.entries()].map(([candidate, list]) => {
		const rs = list.map((x) => x.run);
		const turns = rs.flatMap((r) => r.turns);
		const reqs = turns.flatMap((t) => t.requests);
		const judged = list.map((x) => x.v).filter((v): v is Verdict => !!v && !v.error);
			const load = loads.find((l) => l.model === rs[0].model);
		const reads = turns.flatMap((t) => t.calls).filter((c) => c.name === "read_screen");
		const soft = turns.flatMap((t) => t.checks).filter((c) => c.soft);
		const areas = new Map<string, number[]>();
		for (const r of rs) {
			const area = caseById(r.case)?.area ?? "other";
			areas.set(area, [...(areas.get(area) ?? []), r.score]);
		}
		return {
			candidate,
			model: rs[0].model,
			thinking: rs[0].thinking,
			runs: rs.length,
			passRate: rs.filter((r) => r.pass).length / rs.length,
			checkScore: avg(rs.map((r) => r.score)),
			judgeScore: judged.length ? avg(judged.map((v) => v.score)) : null,
			unfaithful: judged.filter((v) => !v.faithful).length,
			turnMsMedian: median(turns.map((t) => t.ms)),
			turnMsP90: pct(turns.map((t) => t.ms), 0.9),
			callsPerTurn: avg(turns.map((t) => t.calls.length)),
			toolErrors: turns.reduce((n, t) => n + t.toolErrors, 0),
			failedTurns: turns.filter((t) => t.status !== "done").length + rs.filter((r) => r.error).length,
			ttftMedian: median(reqs.map((r) => r.ttft ?? NaN)),
			prefillTps: median(reqs.filter((r) => (r.promptTokens ?? 0) - (r.cachedTokens ?? 0) > 500).map((r) => r.promptTps ?? NaN)),
			decodeTps: median(reqs.filter((r) => (r.completionTokens ?? 0) >= 100).map((r) => r.genTps ?? NaN)),
			thinkingTokensPerTurn: avg(turns.map((t) => t.requests.reduce((n, r) => n + (r.reasoningTokens ?? 0), 0))),
				maxContext: Math.max(0, ...turns.map((t) => t.contextTokens)),
			toolCharsPerTurn: avg(turns.map((t) => t.calls.reduce((n, c) => n + c.output.length, 0))),
			viewReads: share(reads, (c) => !!c.args.view),
			detailReads: share(reads, (c) => c.args.details === true),
			softScore: share(soft, (c) => c.pass),
			memory: load?.actualSize ?? load?.estimatedSize ?? null,
			loadMs: load?.loadMs ?? null,
			byArea: Object.fromEntries([...areas].map(([a, s]) => [a, avg(s)])),
		};
	});
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = {
	pct: (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–"),
	s: (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : "–"),
	n: (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : "–"),
	gb: (b: number | null) => (b ? `${(b / 1e9).toFixed(1)} GB` : "–"),
	k: (x: number) => (x ? `${(x / 1000).toFixed(1)}k` : "–"),
};

export function writeReport(dir: string) {
	const runs = readFileSync(join(dir, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CaseRun & { repeat?: number });
	const loads: Load[] = existsSync(join(dir, "loads.jsonl")) ? readFileSync(join(dir, "loads.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const verdicts: (Verdict | null)[] = existsSync(join(dir, "judge.json")) ? JSON.parse(readFileSync(join(dir, "judge.json"), "utf8")) : [];
	const meta = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : {};
	const summary = summarize(runs, loads, verdicts).sort((a, b) => b.checkScore - a.checkScore || a.turnMsMedian - b.turnMsMedian);
	writeFileSync(join(dir, "summary.json"), JSON.stringify({ meta, candidates: summary }, null, "\t"));

	const caseIds = [...new Set(runs.map((r) => r.case))];
	const cell = (cand: string, id: string) => {
		const rs = runs.map((r, i) => ({ r, i })).filter((x) => x.r.candidate === cand && x.r.case === id);
		if (!rs.length) return `<td></td>`;
		const score = avg(rs.map((x) => x.r.score));
		const passed = rs.filter((x) => x.r.pass).length;
		const v = rs.map((x) => verdicts[x.i]).filter((x): x is Verdict => !!x && !x.error);
		const failed = rs.flatMap((x) => x.r.turns.flatMap((t) => t.checks.filter((c) => !c.pass && !c.soft).map((c) => `${c.label}${c.detail ? `: ${c.detail}` : ""}`))).concat(rs.filter((x) => x.r.error).map((x) => x.r.error!));
		const tone = passed === rs.length ? "good" : score >= 0.5 ? "warn" : "bad";
		return `<td class="${tone}" title="${esc([...new Set(failed)].join("\n"))}"><a href="#run-${rs[0].i}">${passed}/${rs.length}</a>${v.length ? `<small> · ${fmt.n(avg(v.map((x) => x.score)), 1)}</small>` : ""}</td>`;
	};

	const transcript = (r: CaseRun, i: number) => {
		const v = verdicts[i];
		const turns = r.turns
			.map(
				(t, n) => `<div class="turn"><p class="user"><b>Person:</b> ${esc(t.user)}</p>
${t.calls.map((c) => `<details class="call${c.isError ? " err" : ""}"><summary>${esc(c.name)} <code>${esc(JSON.stringify(c.args))}</code> · ${c.output.length.toLocaleString()} chars · ${c.ms} ms</summary><pre>${esc(c.output.slice(0, 20_000))}${c.output.length > 20_000 ? "\n…" : ""}</pre></details>`).join("\n")}
<div class="answer"><b>Agent</b> <small>(${t.status}${t.reason ? `: ${esc(t.reason)}` : ""} · ${fmt.s(t.ms)} · ${t.requests.length} requests · context ${fmt.k(t.contextTokens)} tokens${t.thinkingChars ? ` · thinking ${t.thinkingChars.toLocaleString()} chars` : ""})</small><pre>${esc(t.answer)}</pre></div>
<ul class="checks">${t.checks.map((c) => `<li class="${c.pass ? "ok" : c.soft ? "mute" : "no"}">${c.pass ? "✓" : "✗"} ${esc(c.label)}${c.soft ? " <small>(soft)</small>" : ""}${c.detail ? ` <small>${esc(c.detail)}</small>` : ""}</li>`).join("")}</ul>
${n === r.turns.length - 1 && v && !v.error ? `<p class="judge"><b>Judge ${v.score}/5${v.faithful ? "" : " · unfaithful"}</b> ${v.issues.map(esc).join("; ")}</p>` : ""}</div>`,
			)
			.join("\n");
		return `<details class="run" id="run-${i}"><summary><b>${esc(r.candidate)}</b> · ${esc(r.case)}${(r as { repeat?: number }).repeat ? ` #${(r as { repeat?: number }).repeat! + 1}` : ""} · ${r.pass ? "pass" : "fail"} · ${fmt.pct(r.score)} · ${fmt.s(r.ms)}</summary>${r.error ? `<p class="no">${esc(r.error)}</p>` : ""}${turns}</details>`;
	};

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Model Eval</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--line:#e5e5ea;--card:#f5f5f7;--good:#d9f2e0;--warn:#fbefc9;--bad:#f9d8d6;--acc:#0a63c9}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161618;--fg:#f2f2f7;--mute:#9a9aa0;--line:#2c2c30;--card:#1f1f22;--good:#173d24;--warn:#423711;--bad:#4a1d1b;--acc:#5aa2ff}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,system-ui,sans-serif;margin:0 auto;max-width:1400px;padding:16px}
h1{font-size:22px;margin:4px 0}h2{font-size:17px;margin:28px 0 8px}small,.mute{color:var(--mute)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{font-weight:600;color:var(--mute);font-size:12px}
td.good{background:var(--good)}td.warn{background:var(--warn)}td.bad{background:var(--bad)}a{color:var(--acc);text-decoration:none}
details.run{border:1px solid var(--line);border-radius:8px;margin:6px 0;padding:6px 10px;background:var(--card)}summary{cursor:pointer}
.turn{border-top:1px solid var(--line);margin-top:8px;padding-top:8px}pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:480px;overflow:auto;font-size:12px}
details.call{margin:2px 0 2px 12px;font-size:12px}details.call.err summary{color:#d33}code{font-size:11px}ul.checks{list-style:none;padding:0;margin:4px 0}.ok{color:#1a8a3a}.no{color:#c9302c}.judge{font-size:13px}
</style></head><body>
<h1>Agent model evaluation</h1>
<p class="mute">${esc(meta.startedAt ?? "")} · oMLX ${esc(meta.omlx ?? "")} · ${caseIds.length} cases × ${meta.repeat ?? 1} · ${runs.length} runs. Hover a grid cell for its failed checks; click it for the transcript.</p>
<h2>Leaderboard</h2><div class="wrap"><table><tr><th>Candidate</th><th>Cases passed</th><th>Checks</th><th>Judge</th><th>OnTrack</th><th>Safety</th><th>Turn median</th><th>Turn p90</th><th>Calls/turn</th><th>Tool errors</th><th>Failed turns</th><th>TTFT</th><th>Prefill tok/s</th><th>Decode tok/s</th><th>Thinking tok/turn</th><th>Max context</th><th>Tool chars/turn</th><th>Reads with view</th><th>Reads with details</th><th>Soft checks</th><th>Memory</th></tr>
${summary.map((s) => `<tr><td><b>${esc(s.candidate)}</b></td><td>${fmt.pct(s.passRate)}</td><td>${fmt.pct(s.checkScore)}</td><td>${s.judgeScore === null ? "–" : `${fmt.n(s.judgeScore, 1)}${s.unfaithful ? ` <small>(${s.unfaithful} unfaithful)</small>` : ""}`}</td><td>${fmt.pct(s.byArea.ontrack ?? NaN)}</td><td>${fmt.pct(s.byArea.safety ?? NaN)}</td><td>${fmt.s(s.turnMsMedian)}</td><td>${fmt.s(s.turnMsP90)}</td><td>${fmt.n(s.callsPerTurn, 1)}</td><td>${s.toolErrors}</td><td>${s.failedTurns}</td><td>${fmt.n(s.ttftMedian, 1)} s</td><td>${fmt.n(s.prefillTps)}</td><td>${fmt.n(s.decodeTps)}</td><td>${fmt.n(s.thinkingTokensPerTurn)}</td><td>${fmt.k(s.maxContext)}</td><td>${fmt.k(s.toolCharsPerTurn)}</td><td>${fmt.pct(s.viewReads)}</td><td>${fmt.pct(s.detailReads)}</td><td>${fmt.pct(s.softScore)}</td><td>${fmt.gb(s.memory)}</td></tr>`).join("\n")}
</table></div>
<h2>Cases</h2><div class="wrap"><table><tr><th>Case</th>${summary.map((s) => `<th>${esc(s.candidate)}</th>`).join("")}</tr>
${caseIds.map((id) => `<tr><td title="${esc(caseById(id)?.rubric.join("\n"))}">${esc(caseById(id)?.title ?? id)} <small>${esc(id)}</small></td>${summary.map((s) => cell(s.candidate, id)).join("")}</tr>`).join("\n")}
</table></div>
<h2>Transcripts</h2>${runs.map(transcript).join("\n")}
</body></html>`;
	writeFileSync(join(dir, "report.html"), html);
}
