// Runs one case as a pi-durable conversation: the model gets ToolBelt's MCP tools as its only tools,
// a system prompt like an in-app assistant's, and the person's turns one after another. Records
// what a reviewer needs: every tool call and result, the answer, thinking, timings and tokens.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, section } from "@earendil-works/pi-durable";
import type { Case } from "./cases";
import { runCheck, type CheckResult, type ToolCall } from "./checks";
import { lenient } from "./lenient";
import { omlxProvider, piModel, type Candidate, type OmlxModel, type RequestRecord } from "./omlx";
import type { Seeded } from "./seed";
import { openWorld, type EvalWorld } from "./world";

const context = BACKGROUND_CONTEXT;

export type RunOptions = {
	/** Tool rounds one answer may take. */
	maxTurns: number;
	/** Gives up on an answer after this long. */
	turnTimeoutMs: number;
	/** Output tokens per model request. */
	maxOutput: number;
	/** The recording proxy's base URL and its records. */
	recorder: { url: string; take: () => RequestRecord[] };
	/** Extra system prompt text (a prompt variant). */
	instructions?: string;
	/** Resolve names the way a proposed ToolBelt change would (lenient.ts): an interface variant. */
	lenient?: boolean;
};

export type TurnRecord = {
	user: string;
	answer: string;
	thinkingChars: number;
	calls: ToolCall[];
	/** Tool calls the model made that ToolBelt refused or that didn't validate. */
	toolErrors: number;
	status: "done" | "unanswered" | "timeout" | "error";
	reason?: string;
	ms: number;
	requests: RequestRecord[];
	checks: CheckResult[];
	/** Prompt tokens of the last request: how much context the model was holding. */
	contextTokens: number;
	/** Screens show_screen put in front of the person during the turn ("plugin/screen"). */
	shown?: string[];
};

export type CaseRun = {
	case: string;
	candidate: string;
	model: string;
	thinking: string;
	startedAt: string;
	turns: TurnRecord[];
	/** Fraction of checks passed, over all turns. */
	score: number;
	pass: boolean;
	ms: number;
	error?: string;
	systemPrompt: string;
	tools: string[];
	/** What the seeded data held, for regrading. */
	seeded?: Seeded;
	audit: unknown[];
};

const PREAMBLE = `You are the assistant built into ToolBelt, a Mac menu bar app. You help the person with what their ToolBelt plugins show, mostly their tasks in OnTrack.
Use the ToolBelt tools to look things up before answering; never guess or invent tasks, dates, people or numbers. If something isn't there, say so.
You can read ToolBelt and, when the person asks, show them a screen. You can't change their tasks or anything else: when asked to, say so and tell the person how to do it in ToolBelt.
Answer in plain, concise language. Refer to tasks by name. Give dates and times when they matter.`;

function now() {
	const d = new Date();
	return `${d.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
}

/** The text of an assistant message, without thinking. */
function textOf(content: { type: string; text?: string; thinking?: string }[]) {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("")
		.trim();
}

export async function runCase(c: Case, candidate: Candidate, om: OmlxModel, o: RunOptions): Promise<CaseRun> {
	const started = Date.now();
	const run: CaseRun = {
		case: c.id,
		candidate: candidate.id,
		model: candidate.model,
		thinking: candidate.thinking,
		startedAt: new Date(started).toISOString(),
		turns: [],
		score: 0,
		pass: false,
		ms: 0,
		systemPrompt: "",
		tools: [],
		audit: [],
	};
	let world: EvalWorld | undefined;
	let harness: Harness | undefined;
	try {
		world = await openWorld(c.setup, `eval ${candidate.id} ${c.id}`);
		const w = world;
		const missing = (c.requires ?? []).filter((t) => !w.tools.some((x) => x.name === t));
		if (missing.length) throw new Error(`skipped: the server has no ${missing.join(", ")}`);
		run.tools = w.tools.map((t) => t.name);
		run.seeded = w.seeded;

		let calls: ToolCall[] = [];
		const callTool = o.lenient ? lenient(w.call) : w.call;
		const tools = w.tools.map((t) =>
			defineTool({
				name: t.name,
				description: t.description ?? t.name,
				parameters: t.inputSchema as never,
				execute: async (args: unknown) => {
					const a = (args ?? {}) as Record<string, unknown>;
					const t0 = Date.now();
					const r = await callTool(t.name, a);
					calls.push({ name: t.name, args: a, output: r.text, isError: r.isError, ms: Date.now() - t0 });
					if (r.isError) throw new Error(r.text);
					return { output: [{ type: "text" as const, text: r.text }] };
				},
			}),
		);
		const when = now();
		const sections = [
			section("preamble", () => PREAMBLE, { tag: false }),
			section("toolbelt", () => w.server.instructions),
			section("now", () => `It is ${when}.`),
			...(o.instructions ? [section("extra", () => o.instructions!)] : []),
		];
		run.systemPrompt = [PREAMBLE, `<toolbelt>\n${w.server.instructions}\n</toolbelt>`, `<now>\nIt is ${when}.\n</now>`, o.instructions ?? ""].filter(Boolean).join("\n\n");

		const model = piModel(om, o.recorder.url, o.maxOutput);
		const models = createModels();
		models.setProvider(omlxProvider([model], o.recorder.url));
		const registry = createRegistry();
		registry.install(defineExtension({ name: "toolbelt", tools, sections }));
		const reports: string[] = [];
		harness = await Harness.open(
			new MemoryStorage(),
			{
				models,
				registry,
				identity: { attribution: null },
				onReport: (r) => void reports.push(`${r.kind}: ${(r as { error?: Error }).error?.message ?? ""}`),
				settings: {
					stream: { timeoutMs: o.turnTimeoutMs },
					retry: { maxRetries: 1 },
					compaction: { enabled: true, reserveTokens: Math.min(16_384, Math.floor(model.contextWindow / 4)), keepRecentTokens: Math.floor(model.contextWindow / 4) },
				},
			},
			context,
		);
		const root = await harness.root(context, {
			agent: { model: { provider: "omlx", modelId: om.id }, thinkingLevel: candidate.thinking === "on" ? "medium" : "off", maxTurns: o.maxTurns },
		});
		o.recorder.take();

		let lastEntry = 0;
		for (const turn of c.turns) {
			for (const p of turn.person ?? []) await w.person(p);
			calls = [];
			const shownBefore = w.navigated.length;
			const t0 = Date.now();
			const record: TurnRecord = { user: turn.user, answer: "", thinkingChars: 0, calls, toolErrors: 0, status: "error", ms: 0, requests: [], checks: [], contextTokens: 0 };
			try {
				const submission = await root.submit({ type: "input", content: turn.user }, context);
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), o.turnTimeoutMs)));
				const settled = await Promise.race([submission.wait(context), timeout]);
				clearTimeout(timer);
				if (settled === "timeout") {
					record.status = "timeout";
					record.reason = `no answer within ${Math.round(o.turnTimeoutMs / 1000)} s`;
					await root.abort(context);
				} else {
					record.status = settled.status;
					if (settled.status === "unanswered") record.reason = JSON.stringify((settled as { reason?: unknown }).reason ?? settled).slice(0, 300);
				}
			} catch (e) {
				record.status = "error";
				record.reason = (e as Error).message;
			}
			record.ms = Date.now() - t0;
			// The turn's entries, oldest first: assistant messages carry the answer and thinking.
			const page = await root.entries({ minEntryId: lastEntry + 1, order: "ascending" } as never, 500, undefined, context);
			let answer = "";
			for (const e of page.items as unknown as { id: number; kind: string; model?: { role: string; content: unknown }[] }[]) {
				lastEntry = Math.max(lastEntry, e.id);
				if (e.kind !== "pi.assistant") continue;
				for (const m of e.model ?? []) {
					const content = (m.content ?? []) as { type: string; text?: string; thinking?: string }[];
					record.thinkingChars += content.filter((x) => x.type === "thinking").reduce((n, x) => n + (x.thinking?.length ?? 0), 0);
					const text = textOf(content);
					if (text) answer = text;
				}
			}
			record.answer = answer;
			record.toolErrors = calls.filter((x) => x.isError).length;
			await Bun.sleep(50);
			record.requests = o.recorder.take();
			record.contextTokens = record.requests.at(-1)?.promptTokens ?? 0;
			record.shown = w.navigated.slice(shownBefore);
			if (reports.length) record.reason = [record.reason, ...reports.splice(0)].filter(Boolean).join("; ");
			const checks = typeof turn.checks === "function" ? turn.checks(w.seeded) : turn.checks;
			record.checks = checks.map((ch) => runCheck(ch, answer, calls, record.shown));
			if (record.status !== "done") record.checks.push({ label: "answered", kind: "pattern", pass: false, detail: record.reason });
			run.turns.push(record);
		}
		run.audit = w.audit();
	} catch (e) {
		run.error = (e as Error).message;
	} finally {
		await harness?.close(context).catch(() => {});
		await world?.stop().catch(() => {});
	}
	score(run);
	run.ms = Date.now() - started;
	return run;
}

/** Soft checks (how the agent got there) are reported but don't count. */
export function score(run: CaseRun) {
	const all = run.turns.flatMap((t) => t.checks).filter((x) => !x.soft);
	run.score = all.length ? all.filter((x) => x.pass).length / all.length : 0;
	run.pass = !run.error && all.length > 0 && all.every((x) => x.pass);
}

/** Applies the case's current checks to a stored run: for checks changed after it ran. */
export function regrade(run: CaseRun, c: Case, seeded: Seeded) {
	c.turns.forEach((turn, i) => {
		const t = run.turns[i];
		if (!t) return;
		const checks = typeof turn.checks === "function" ? turn.checks(run.seeded ?? seeded) : turn.checks;
		t.checks = checks.map((ch) => runCheck(ch, t.answer, t.calls, t.shown));
		if (t.status !== "done") t.checks.push({ label: "answered", kind: "pattern", pass: false, detail: t.reason });
	});
	score(run);
}
