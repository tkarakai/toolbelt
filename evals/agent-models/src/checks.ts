// Deterministic grading of one turn: the answer text and the tool calls the agent made.
import type { Check } from "./cases";

export type ToolCall = { name: string; args: Record<string, unknown>; output: string; isError: boolean; ms: number };
export type CheckResult = { label: string; kind: Check["kind"]; pass: boolean; detail?: string };

/** Lower-case, unify quotes, dashes and spaces, and drop markdown emphasis, so facts match however they're typeset. */
export function normalize(s: string) {
	return s
		.normalize("NFKC")
		.replace(/[‘’ʼ]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.replace(/[*_`]+/g, "")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

/** One item: alternatives separated by `|`, each a regular expression matched case-insensitively. */
export function itemMatches(text: string, item: string) {
	const t = normalize(text);
	return item.split("|").some((alt) => {
		const a = normalize(alt);
		try {
			return new RegExp(a, "i").test(t);
		} catch {
			return t.includes(a);
		}
	});
}

const argsMatch = (args: Record<string, unknown>, want: Record<string, unknown>) =>
	Object.entries(want).every(([k, v]) => String(args[k] ?? "").toLowerCase() === String(v).toLowerCase());

export function runCheck(check: Check, answer: string, calls: ToolCall[]): CheckResult {
	const base = { label: check.label, kind: check.kind };
	switch (check.kind) {
		case "mentions": {
			const hits = check.items.filter((i) => itemMatches(answer, i));
			const need = check.atLeast ?? check.items.length;
			const missing = check.items.filter((i) => !hits.includes(i));
			return { ...base, pass: hits.length >= need, detail: missing.length ? `missing: ${missing.join(", ")} (${hits.length}/${need} needed)` : undefined };
		}
		case "absent": {
			const found = check.items.filter((i) => itemMatches(answer, i));
			return { ...base, pass: found.length === 0, detail: found.length ? `mentions: ${found.join(", ")}` : undefined };
		}
		case "pattern": {
			const m = new RegExp(check.re, check.flags ?? "").exec(answer.replace(/[*_`]+/g, "").replace(/[‘’ʼ]/g, "'"));
			const pass = check.not ? !m : !!m;
			return { ...base, pass, detail: pass ? undefined : check.not ? `matched: "${m![0]}"` : "no match" };
		}
		case "called": {
			const names = check.tool.split("|");
			const hit = calls.find((c) => names.includes(c.name) && (!check.args || argsMatch(c.args, check.args)));
			return { ...base, pass: !!hit, detail: hit ? undefined : `calls: ${calls.map((c) => c.name).join(", ") || "none"}` };
		}
		case "neverSeen": {
			const leaked = check.items.filter((i) => calls.some((c) => c.output.includes(i)));
			return { ...base, pass: leaked.length === 0, detail: leaked.length ? `tool output contained: ${leaked.join(", ")}` : undefined };
		}
		case "maxCalls":
			return { ...base, pass: calls.length <= check.max, detail: calls.length > check.max ? `${calls.length} calls` : undefined };
	}
}
