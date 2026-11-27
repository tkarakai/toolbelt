// Deterministic grading of one turn: the answer text and the tool calls the agent made.
import type { Check } from "./cases";

export type ToolCall = { name: string; args: Record<string, unknown>; output: string; isError: boolean; ms: number };
export type CheckResult = { label: string; kind: Check["kind"]; pass: boolean; detail?: string; soft?: boolean };

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

/**
 * One item: a regular expression matched case-insensitively, so `|` separates alternatives and
 * groups such as `wasn't (allowed|approved)` work. Text that isn't a valid expression matches as
 * plain alternatives.
 */
export function itemMatches(text: string, item: string) {
	const t = normalize(text);
	const a = normalize(item);
	try {
		return new RegExp(a, "i").test(t);
	} catch {
		return a.split("|").some((alt) => t.includes(alt));
	}
}

/**
 * Whether the arguments contain what the check wants: strings compare case-insensitively, objects
 * by the wanted keys, and a wanted list's items must all be in the actual list.
 */
export function argsMatch(actual: unknown, want: unknown): boolean {
	if (want && typeof want === "object" && !Array.isArray(want))
		return !!actual && typeof actual === "object" && Object.entries(want).every(([k, v]) => argsMatch((actual as Record<string, unknown>)[k], v));
	if (Array.isArray(want)) return Array.isArray(actual) && want.every((w) => actual.some((a) => argsMatch(a, w)));
	return String(actual ?? "").toLowerCase() === String(want).toLowerCase();
}

/** `shown`: the screens show_screen put in front of the person during the turn. */
export function runCheck(check: Check, answer: string, calls: ToolCall[], shown: string[] = []): CheckResult {
	const base = { label: check.label, kind: check.kind, ...(check.soft ? { soft: true } : {}) };
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
			const hit = calls.find((c) => names.includes(c.name) && (!check.args || argsMatch(c.args, check.args)) && (!check.ok || !c.isError));
			return { ...base, pass: !!hit, detail: hit ? undefined : `calls: ${calls.map((c) => c.name).join(", ") || "none"}` };
		}
		case "neverSeen": {
			const leaked = check.items.filter((i) => calls.some((c) => c.output.includes(i)));
			return { ...base, pass: leaked.length === 0, detail: leaked.length ? `tool output contained: ${leaked.join(", ")}` : undefined };
		}
		case "shown": {
			const pass = check.not ? shown.length === 0 : shown.some((x) => !check.screen || x === check.screen);
			return { ...base, pass, detail: pass ? undefined : `shown: ${shown.join(", ") || "nothing"}` };
		}
		case "maxCalls":
			return { ...base, pass: calls.length <= check.max, detail: calls.length > check.max ? `${calls.length} calls` : undefined };
	}
}
