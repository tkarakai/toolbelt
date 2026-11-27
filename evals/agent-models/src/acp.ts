// Runs one case through an ACP agent the way the ToolBelt Agent plugin (tkarakai/toolbelt-agent)
// does: Claude Code's adapter (`claude-agent-acp`) with the plugin's isolation (no built-in tools,
// none of the person's settings or MCP servers), ToolBelt's MCP server as its only server, the
// plugin's preamble before the first question, and permission only for ToolBelt's tools. The model
// is reached through environment lines, as the plugin's Claude Code setup takes them, pointed at
// the recording proxy (which adds oMLX's key, so the agent never sees it).
//
// Produces the same CaseRun as agent.ts, so checks, regrade and the report apply unchanged.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "../../../test/agent-scenarios/adapters";
import type { CaseRun, RunOptions, TurnRecord } from "./agent";
import { score } from "./agent";
import type { Case } from "./cases";
import { runCheck, type ToolCall } from "./checks";
import type { Candidate, OmlxModel } from "./omlx";
import { openWorld, type EvalWorld } from "./world";

/** The plugin's preamble (src/session.ts in toolbelt-agent), sent with the first question. */
export const PLUGIN_PREAMBLE = `You are the assistant inside ToolBelt, a macOS app whose plugins show screens (tasks, software updates, processes and more). The person is looking at ToolBelt while they talk to you.

Answer from ToolBelt's screens with the \`toolbelt\` MCP tools: \`toolbelt_status\` lists the plugins, \`list_screens\` their screens and view controls, \`read_screen\` reads one with your own search, filters and sort, \`search_screens\` searches across them, and \`show_screen\` puts a screen on the person's display (they approve it the first time). Show them what you found when it helps.

You have no other tools here: no files, no shell, no web. Keep answers short and concrete.`;

/** The plugin's Claude Code isolation (CLAUDE_ISOLATION in toolbelt-agent's session.ts). */
export const CLAUDE_ISOLATION = { claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true, allowDangerouslySkipPermissions: false } } };

type Update = { sessionUpdate: string; content?: { type: string; text?: string } | unknown[]; toolCallId?: string; title?: string; rawInput?: unknown; rawOutput?: unknown; status?: string; _meta?: Record<string, unknown> };

/** A minimal ACP client over a child process's stdio. */
class Acp {
	private id = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private proc: ReturnType<typeof Bun.spawn>;
	stderr = "";
	constructor(command: string[], env: Record<string, string>, cwd: string, private onUpdate: (u: Update) => void) {
		const proc = Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.proc = proc;
		void this.read();
		void (async () => {
			for await (const c of proc.stderr as ReadableStream<Uint8Array>) this.stderr = (this.stderr + new TextDecoder().decode(c)).slice(-4000);
		})();
	}
	private async read() {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true });
			let i: number;
			while ((i = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, i).trim();
				buffer = buffer.slice(i + 1);
				if (line) this.receive(JSON.parse(line));
			}
		}
		for (const p of this.pending.values()) p.reject(new Error(`the agent exited: ${this.stderr.slice(-500)}`));
		this.pending.clear();
	}
	private write(m: unknown) {
		const stdin = this.proc.stdin as import("bun").FileSink;
		stdin.write(JSON.stringify(m) + "\n");
		stdin.flush();
	}
	private receive(m: { id?: number; method?: string; params?: any; result?: unknown; error?: { message: string } }) {
		if (m.method === "session/update") return this.onUpdate(m.params.update);
		if (m.method === "session/request_permission") {
			// Only ToolBelt's tools, as the plugin allows.
			const p = m.params as { toolCall: { title?: string }; options: { optionId: string; kind: string }[] };
			const ok = /toolbelt/i.test(JSON.stringify(p.toolCall));
			const option = p.options.find((o) => o.kind === (ok ? "allow_once" : "reject_once")) ?? p.options.find((o) => o.kind.startsWith(ok ? "allow" : "reject"));
			return this.write({ jsonrpc: "2.0", id: m.id, result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
		}
		if (m.method && m.id !== undefined) return this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `${m.method} isn't offered` } });
		const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
		if (!p) return;
		this.pending.delete(m.id!);
		m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
	}
	request<T>(method: string, params: unknown): Promise<T> {
		const id = this.id++;
		this.write({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	notify(method: string, params: unknown) {
		this.write({ jsonrpc: "2.0", method, params });
	}
	close() {
		this.proc.kill();
	}
}

/** ToolBelt's tool name from an ACP tool call: `mcp__toolbelt__read_screen`, or a title naming it. */
function toolOf(u: Update): string {
	const meta = (u._meta?.claudeCode as { toolName?: string } | undefined)?.toolName;
	const text = [meta, u.title].filter(Boolean).join(" ");
	return text.match(/mcp__toolbelt__([a-z_]+)/)?.[1] ?? text.match(/\b(toolbelt_status|list_screens|read_screen|search_screens|show_screen)\b/)?.[1] ?? (u.title || "unknown");
}

function outputOf(u: Update): string {
	if (Array.isArray(u.content))
		return u.content
			.map((c: any) => (c?.type === "content" ? (c.content?.text ?? "") : c?.text ?? ""))
			.join("\n");
	if (typeof u.rawOutput === "string") return u.rawOutput;
	if (Array.isArray(u.rawOutput)) return u.rawOutput.map((c: any) => c?.text ?? "").join("\n");
	return u.rawOutput ? JSON.stringify(u.rawOutput) : "";
}

export type AcpOptions = RunOptions & { command: string[] };

export async function runCaseAcp(c: Case, candidate: Candidate, om: OmlxModel, o: AcpOptions): Promise<CaseRun> {
	const started = Date.now();
	const run: CaseRun = { case: c.id, candidate: candidate.id, model: candidate.model, thinking: candidate.thinking, startedAt: new Date(started).toISOString(), turns: [], score: 0, pass: false, ms: 0, systemPrompt: `(Claude Code's own, isolated)\n\nFirst message:\n${PLUGIN_PREAMBLE}`, tools: [], audit: [] };
	let world: EvalWorld | undefined;
	let agent: Acp | undefined;
	const workdir = mkdtempSync(join(tmpdir(), "tb-acp-"));
	try {
		world = await openWorld(c.setup, `eval ${candidate.id} ${c.id}`);
		const w = world;
		run.tools = w.tools.map((t) => t.name);
		run.seeded = w.seeded;
		const missing = (c.requires ?? []).filter((t) => !w.tools.some((x) => x.name === t));
		if (missing.length) throw new Error(`skipped: the server has no ${missing.join(", ")}`);

		// Per turn: the answer text and tool calls, from the agent's updates.
		let answer = "";
		let thinking = 0;
		const calls = new Map<string, ToolCall & { t0: number }>();
		const order: string[] = [];
		const onUpdate = (u: Update) => {
			if (u.sessionUpdate === "agent_message_chunk" && !Array.isArray(u.content)) answer += u.content?.text ?? "";
			else if (u.sessionUpdate === "agent_thought_chunk" && !Array.isArray(u.content)) thinking += u.content?.text?.length ?? 0;
			else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
				const id = u.toolCallId!;
				let call = calls.get(id);
				if (!call) {
					call = { name: toolOf(u), args: {}, output: "", isError: false, ms: 0, t0: Date.now() };
					calls.set(id, call);
					order.push(id);
				}
				if (u.title && call.name === "unknown") call.name = toolOf(u);
				if (u.rawInput && typeof u.rawInput === "object" && Object.keys(u.rawInput).length) call.args = u.rawInput as Record<string, unknown>;
				const out = outputOf(u);
				if (out) call.output = out;
				if (u.status === "failed") call.isError = true;
				if (u.status === "completed" || u.status === "failed") call.ms = Date.now() - call.t0;
			}
		};
		const base = o.recorder.url.replace(/\/v1$/, "");
		const env: Record<string, string> = {
			HOME: process.env.HOME ?? "",
			USER: process.env.USER ?? "",
			PATH: process.env.PATH ?? "",
			TERM: "dumb",
			// The plugin's Claude Code Environment lines, as docs/other-agents.md suggests for oMLX.
			ANTHROPIC_BASE_URL: base,
			ANTHROPIC_AUTH_TOKEN: "eval",
			ANTHROPIC_MODEL: om.id,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: om.id,
			MAX_THINKING_TOKENS: candidate.thinking === "on" ? "8000" : "0",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			// More lines for the agent, such as a proxy or CLAUDE_CONFIG_DIR: EVAL_AGENT_ENV_<NAME>=value.
			...Object.fromEntries(
				Object.entries(process.env)
					.filter(([k, v]) => k.startsWith("EVAL_AGENT_ENV_") && v !== undefined)
					.map(([k, v]) => [k.slice("EVAL_AGENT_ENV_".length), v as string]),
			),
		};
		agent = new Acp(o.command, env, workdir, onUpdate);
		const a = agent;
		await a.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "toolbelt-agent", title: "ToolBelt Agent", version: "0.1.0" } });
		const toolbelt = { name: "toolbelt", command: process.execPath, args: [CLI, "--socket", w.world.socket, "mcp"], env: [] };
		const { sessionId, modes } = await a.request<{ sessionId: string; modes?: { currentModeId: string } }>("session/new", { cwd: workdir, mcpServers: [toolbelt], _meta: CLAUDE_ISOLATION });
		// The adapter takes the person's permissions.defaultMode (often "auto", whose safety check runs on
		// Anthropic's servers and refuses everything through another endpoint): ask for the default mode,
		// where ToolBelt's tools are allowed through permission requests, as the plugin does.
		if (modes && modes.currentModeId !== "default") await a.request("session/set_mode", { sessionId, modeId: "default" });
		o.recorder.take();

		let first = true;
		for (const turn of c.turns) {
			for (const p of turn.person ?? []) await w.person(p);
			answer = "";
			thinking = 0;
			calls.clear();
			order.length = 0;
			const shownBefore = w.navigated.length;
			const t0 = Date.now();
			const record: TurnRecord = { user: turn.user, answer: "", thinkingChars: 0, calls: [], toolErrors: 0, status: "error", ms: 0, requests: [], checks: [], contextTokens: 0 };
			const prompt = [...(first ? [{ type: "text", text: PLUGIN_PREAMBLE }] : []), { type: "text", text: turn.user }];
			first = false;
			try {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), o.turnTimeoutMs)));
				const settled = await Promise.race([a.request<{ stopReason: string }>("session/prompt", { sessionId, prompt }), timeout]);
				clearTimeout(timer);
				if (settled === "timeout") {
					record.status = "timeout";
					record.reason = `no answer within ${Math.round(o.turnTimeoutMs / 1000)} s`;
					a.notify("session/cancel", { sessionId });
				} else {
					record.status = settled.stopReason === "end_turn" ? "done" : "unanswered";
					if (record.status !== "done") record.reason = `stopReason ${settled.stopReason}`;
				}
			} catch (e) {
				record.status = "error";
				record.reason = (e as Error).message;
			}
			record.ms = Date.now() - t0;
			record.answer = answer.trim();
			record.thinkingChars = thinking;
			record.calls = order.map((id) => {
				const { t0: _, ...call } = calls.get(id)!;
				// The MCP result's error flag doesn't survive ACP; ToolBelt's refusals read like this.
				if (!call.isError && /^(Error -?\d+:|ToolBelt refused|Unknown |No (plugin|screen)|Invalid )/i.test(call.output)) call.isError = true;
				return call;
			});
			record.toolErrors = record.calls.filter((x) => x.isError).length;
			await Bun.sleep(50);
			record.requests = o.recorder.take();
			record.contextTokens = record.requests.at(-1)?.promptTokens ?? 0;
			record.shown = w.navigated.slice(shownBefore);
			const checks = typeof turn.checks === "function" ? turn.checks(w.seeded) : turn.checks;
			record.checks = checks.map((ch) => runCheck(ch, record.answer, record.calls, record.shown));
			if (record.status !== "done") record.checks.push({ label: "answered", kind: "pattern", pass: false, detail: record.reason });
			run.turns.push(record);
			if (record.status === "error") break;
		}
		run.audit = w.audit();
	} catch (e) {
		run.error = `${(e as Error).message}${agent?.stderr ? ` | ${agent.stderr.slice(-300)}` : ""}`;
	} finally {
		agent?.close();
		await world?.stop().catch(() => {});
		rmSync(workdir, { recursive: true, force: true });
	}
	score(run);
	run.ms = Date.now() - started;
	return run;
}
