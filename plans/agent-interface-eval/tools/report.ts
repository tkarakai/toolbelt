// Builds report.html from cases.json, each case's recorded results and transcripts, the MCP
// Inspector output and the Settings → Agents screenshots. Self-contained: one file, no network.
// bun plans/agent-interface-eval/tools/report.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const data = JSON.parse(readFileSync(join(root, "cases.json"), "utf8"));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Enough Markdown for the answers: paragraphs, lists, bold, italic, code. */
function md(text: string) {
	const inline = (s: string) =>
		esc(s)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
	return text
		.split(/\n{2,}/)
		.map((block) => {
			const lines = block.split("\n");
			if (lines.every((l) => /^- /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
			if (lines.every((l) => /^\d+\. /.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`;
			return `<p>${lines.map(inline).join("<br>")}</p>`;
		})
		.join("");
}

type Step = { step: string; args?: unknown; ms?: number; isError?: boolean; text?: string; result?: string; received?: unknown; ok?: boolean; error?: unknown };
function evidence(id: string) {
	const dir = join(root, "cases", id);
	const parts: string[] = [];
	if (existsSync(join(dir, "results.json"))) {
		const results: Step[] = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")).slice(2);
		for (const r of results) {
			const body = r.text ?? r.result ?? (r.received ? JSON.stringify(r.received) : r.error ? JSON.stringify(r.error) : r.ok !== undefined ? "ok" : "");
			const label = `${r.step}${r.args && Object.keys(r.args as object).length ? ` ${JSON.stringify(r.args)}` : ""}`;
			parts.push(
				`<details class="step${r.isError ? " refused" : ""}"><summary><span class="mono">${esc(label)}</span>${r.ms !== undefined ? `<span class="ms">${r.ms} ms</span>` : ""}${r.isError ? `<span class="pill warn">refused</span>` : ""}<span class="size">${body.length.toLocaleString()} chars</span></summary><pre>${esc(body)}</pre></details>`,
			);
		}
		const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8").trim().split("\n");
		parts.push(`<details class="raw"><summary>Raw JSON-RPC transcript (${transcript.length} messages, through the stdio shim)</summary><pre>${esc(transcript.map((l) => { const m = JSON.parse(l); return `${String(m.t).padStart(5)} ms ${m.dir} ${JSON.stringify(m.message)}`; }).join("\n"))}</pre></details>`);
	} else if (existsSync(join(dir, "transcript.txt"))) {
		const text = readFileSync(join(dir, "transcript.txt"), "utf8").trim();
		parts.push(`<details class="step" open><summary>Terminal session (${text.length.toLocaleString()} chars)</summary><pre>${esc(text)}</pre></details>`);
	}
	return parts.join("");
}

const verdictPill = (v: string) => `<span class="pill ${v === "pass" ? "ok" : v === "partial" ? "warn" : "bad"}">${v}</span>`;
const cases: any[] = data.cases;
const count = (v: string) => cases.filter((c) => c.verdict === v).length;
const screens = existsSync(join(root, "screens")) ? readdirSync(join(root, "screens")).filter((f) => f.endsWith(".png")).sort() : [];
const img = (f: string) => `data:image/png;base64,${readFileSync(join(root, "screens", f)).toString("base64")}`;
const SCREEN_CAPTIONS: Record<string, string> = {
	"settings-agents-light.png": "Settings → Agents: the switch and how to connect an agent",
	"settings-agents-plugins.png": "Per-plugin access and the activity log (dark)",
	"settings-agents-narrow-light.png": "Narrow window, light",
	"settings-agents-narrow-plugins.png": "Narrow window: plugins and activity",
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Interface Evaluation</title>
<style>
:root { --bg:#fbfaf8; --card:#fff; --fg:#1d1d1f; --muted:#6b6b70; --line:#e6e3de; --code:#f3f1ed; --ok:#1f7a3f; --okbg:#e3f3e8; --warn:#8a5a00; --warnbg:#fbefd5; --bad:#a3262a; --badbg:#f9e0e0; --accent:#3b5bdb; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141416; --card:#1c1c1f; --fg:#ececee; --muted:#9a9aa2; --line:#2c2c31; --code:#232327; --ok:#7ad69a; --okbg:#173322; --warn:#f0c26b; --warnbg:#3a2c10; --bad:#f19a9c; --badbg:#3d1a1b; --accent:#8ea2ff; } }
:root[data-theme="dark"] { --bg:#141416; --card:#1c1c1f; --fg:#ececee; --muted:#9a9aa2; --line:#2c2c31; --code:#232327; --ok:#7ad69a; --okbg:#173322; --warn:#f0c26b; --warnbg:#3a2c10; --bad:#f19a9c; --badbg:#3d1a1b; --accent:#8ea2ff; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 40px 16px 80px; }
h1 { font-size: 30px; line-height:1.2; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 20px; margin: 48px 0 12px; }
h3 { font-size: 16px; margin: 0; }
p { margin: 0 0 10px; }
.lede { color: var(--muted); max-width: 70ch; }
.mono, code, pre { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code); padding: 12px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; max-height: 520px; overflow-y: auto; }
.stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0 8px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.stat b { display:block; font-size: 26px; line-height: 1.1; }
.stat span { color: var(--muted); font-size: 13px; }
.meta { background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 14px 18px; margin-top: 16px; }
.meta dt { font-weight: 600; font-size: 13px; color: var(--muted); margin-top: 8px; }
.meta dd { margin: 2px 0 0; }
.meta ul { margin: 2px 0 0; padding-left: 18px; }
table { width: 100%; border-collapse: collapse; background: var(--card); border:1px solid var(--line); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 14px; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
tr:last-child td { border-bottom: 0; }
td a { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--muted); }
.pill { display:inline-block; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.pill.ok { color: var(--ok); background: var(--okbg); } .pill.warn { color: var(--warn); background: var(--warnbg); } .pill.bad { color: var(--bad); background: var(--badbg); }
.case { background: var(--card); border:1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin: 16px 0; scroll-margin-top: 16px; }
.case header { display:flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; justify-content: space-between; }
.case .who { color: var(--muted); font-size: 13px; }
.prompt { margin: 12px 0; padding: 10px 14px; border-left: 3px solid var(--accent); background: var(--code); border-radius: 0 8px 8px 0; font-size: 15px; }
.calls { margin: 0 0 12px; padding: 0; list-style: none; display:flex; flex-wrap: wrap; gap: 6px; }
.calls li { font-family: ui-monospace, Menlo, monospace; font-size: 12px; border:1px solid var(--line); border-radius: 6px; padding: 2px 7px; }
.answer { border:1px solid var(--line); border-radius: 10px; padding: 12px 16px 4px; }
.answer h4, .notes h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.answer ul, .answer ol { margin: 0 0 10px; padding-left: 20px; }
.notes { margin-top: 12px; font-size: 14px; color: var(--muted); }
details { margin-top: 8px; }
summary { cursor: pointer; font-size: 13px; display:flex; flex-wrap: wrap; gap: 8px; align-items: center; }
summary .ms, summary .size { color: var(--muted); font-size: 12px; }
.findings { display:grid; gap: 10px; }
.finding { background: var(--card); border:1px solid var(--line); border-radius: 10px; padding: 10px 14px; }
.finding b { margin-right: 6px; }
.shots { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
figure { margin: 0; background: var(--card); border:1px solid var(--line); border-radius: 12px; padding: 10px; }
figure img { width: 100%; height: auto; border-radius: 6px; display:block; }
figcaption { font-size: 13px; color: var(--muted); margin-top: 6px; }
@media (max-width: 640px) { th:nth-child(3), td:nth-child(3) { display:none; } h1 { font-size: 24px; } }
</style>
</head>
<body>
<main>
<h1>Agent interface evaluation</h1>
<p class="lede">Roadmap items 1–4 of <code>plans/agent-interface.md</code>: Processes opting out, the read-only agent API (phase 1a), the MCP server with its stdio shim, and the <code>toolbelt</code> CLI with its skill file. Each case is a request a person might make. Claude played the agent: it picked the tool calls, read what ToolBelt returned and wrote the answer shown.</p>
<div class="stats">
<div class="stat"><b>${cases.length}</b><span>cases</span></div>
<div class="stat"><b>${count("pass")}</b><span>answered well</span></div>
<div class="stat"><b>${count("partial")}</b><span>answered with a gap</span></div>
<div class="stat"><b>${count("fail")}</b><span>not answerable</span></div>
<div class="stat"><b>${data.fixed.length}</b><span>issues found and fixed</span></div>
</div>
<dl class="meta">
<dt>Run</dt><dd>${esc(data.run.date)} · ${esc(data.run.host)}</dd>
<dt>Plugins (latest releases)</dt><dd><ul>${data.run.plugins.map((p: string) => `<li>${esc(p)}</li>`).join("")}</ul></dd>
<dt>Data</dt><dd>${esc(data.run.data)}</dd>
<dt>Agent</dt><dd>${esc(data.run.agent)}</dd>
</dl>

<h2>Overview</h2>
<table>
<thead><tr><th>#</th><th>Request</th><th>Channel</th><th>Verdict</th></tr></thead>
<tbody>
${cases.map((c, i) => `<tr><td>${i + 1}</td><td><a href="#${c.id}">${esc(c.title)}</a></td><td>${esc(c.channel)}</td><td>${verdictPill(c.verdict)}</td></tr>`).join("\n")}
</tbody>
</table>

<h2>Cases</h2>
${cases
	.map(
		(c, i) => `<section class="case" id="${c.id}">
<header><h3>${i + 1}. ${esc(c.title)}</h3>${verdictPill(c.verdict)}</header>
<div class="who">${esc(c.persona)} · ${esc(c.channel)}</div>
<div class="prompt">${esc(c.prompt)}</div>
<ul class="calls">${c.calls.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>
<div class="answer"><h4>The agent's answer</h4>${md(c.answer)}</div>
<div class="notes"><h4>Notes</h4>${md(c.notes)}</div>
${evidence(c.id)}
</section>`,
	)
	.join("\n")}

<h2>Client compatibility</h2>
${data.compatibility.map((c: any) => `<div class="finding">${verdictPill(c.result)} <b>${esc(c.client)}</b>${esc(c.notes)}</div>`).join("")}
<details><summary>MCP Inspector output</summary><pre>${esc(readFileSync(join(root, "inspector.txt"), "utf8"))}</pre></details>

<h2>Found and fixed during the evaluation</h2>
<div class="findings">${data.fixed.map((f: any) => `<div class="finding"><b>${f.id}</b><strong>${esc(f.title)}.</strong> ${esc(f.detail)}</div>`).join("")}</div>

<h2>Open findings</h2>
<div class="findings">${data.open.map((f: any) => `<div class="finding"><b>${f.id}</b><strong>${esc(f.title)}.</strong> ${esc(f.detail)}</div>`).join("")}</div>

<h2>Settings → Agents</h2>
<div class="shots">${screens.map((f) => `<figure><img src="${img(f)}" alt="${esc(SCREEN_CAPTIONS[f] ?? f)}"><figcaption>${esc(SCREEN_CAPTIONS[f] ?? f)}</figcaption></figure>`).join("")}</div>

<h2>Reproduce</h2>
<p>From the repository root: <code>bun install --frozen-lockfile && bun run views</code>, then <code>sh plans/agent-interface-eval/tools/restart-preview.sh</code>. Load the four archives with <code>tools/rpc.ts 5281 development '{"operation":"load",…}'</code>, seed with <code>tools/seed.ts</code>, and run a case with <code>bun plans/agent-interface-eval/tools/mcp-run.ts &lt;case dir&gt; &lt;steps.json&gt;</code> or <code>tools/cli-run.sh</code>. Rebuild this page with <code>bun plans/agent-interface-eval/tools/report.ts</code>. Local paths in the records are replaced by placeholders such as &lt;tmp&gt; and &lt;eval&gt;.</p>
</main>
</body>
</html>
`;
writeFileSync(join(root, "report.html"), html);
console.log(`report.html: ${cases.length} cases, ${(html.length / 1024).toFixed(0)} KB`);
