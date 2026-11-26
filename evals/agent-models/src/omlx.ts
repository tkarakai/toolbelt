// oMLX: which models it serves and how to reach them through pi-ai, plus a recording proxy that keeps
// what pi-ai drops: oMLX's per-request timings (time to first token, prefill and decode speed).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const OMLX_URL = process.env.OMLX_URL ?? "http://127.0.0.1:8000";
/** oMLX's API key: OMLX_API_KEY, else the one in oMLX's own settings file. Never written to results. */
export const OMLX_KEY = process.env.OMLX_API_KEY ?? localKey();

function localKey(): string {
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), ".omlx/settings.json"), "utf8"));
		return settings?.auth?.api_key ?? "";
	} catch {
		return "";
	}
}

export type OmlxModel = {
	id: string;
	engine_type: string;
	config_model_type: string;
	estimated_size: number;
	actual_size: number | null;
	loaded: boolean;
	model_context_length: number | null;
	/** The context oMLX allows for this model (its own setting, else the server's). */
	max_context_window: number | null;
	max_tokens: number | null;
	thinking_default: boolean | null;
	reasoning_levels?: string[];
	is_helper: boolean;
	is_hidden: boolean;
	model_path: string;
};

const headers = () => (OMLX_KEY ? { Authorization: `Bearer ${OMLX_KEY}` } : ({} as Record<string, string>));

export async function omlxStatus(): Promise<{ final_ceiling: number; current_model_memory: number; models: OmlxModel[] }> {
	const r = await fetch(`${OMLX_URL}/v1/models/status`, { headers: headers() });
	if (r.status === 401) throw new Error("oMLX wants an API key: set OMLX_API_KEY (oMLX → Settings → Server)");
	if (!r.ok) throw new Error(`oMLX ${OMLX_URL}/v1/models/status: HTTP ${r.status}`);
	return r.json();
}

export async function omlxServer(): Promise<{ version: string; loaded_models: string[]; active_requests: number }> {
	const r = await fetch(`${OMLX_URL}/api/status`, { headers: headers() });
	return r.ok ? r.json() : { version: "unknown", loaded_models: [], active_requests: 0 };
}

/**
 * Models that can't hold a conversation: speech, embeddings, helpers, and speculative-decoding
 * drafts (DFlash, `-assistant`, `mtp-` multi-token-prediction heads, which oMLX can't load alone).
 */
const NOT_CHAT = /(embed|asr|audio|orpheus|tts|whisper|markitdown|nomic|dflash|-assistant|^mtp-)/i;

/** Chat models worth evaluating: not helpers, not hidden, at least 1 GB of weights. */
export const isChatCandidate = (m: OmlxModel) =>
	!m.is_helper && !m.is_hidden && !NOT_CHAT.test(m.id) && !NOT_CHAT.test(m.config_model_type ?? "") && m.estimated_size >= 1e9 && m.engine_type !== "markitdown";

export type Thinking = "off" | "on";

/** A model and how it's run: one column of the results. */
export type Candidate = { id: string; model: string; thinking: Thinking };
export const candidateId = (model: string, thinking: Thinking) => `${model}${thinking === "on" ? "+think" : ""}`;

export function parseCandidate(spec: string): Candidate {
	const [model, t] = spec.split(":");
	const thinking: Thinking = t === "think" || t === "on" ? "on" : "off";
	return { id: candidateId(model, thinking), model, thinking };
}

/** The pi-ai model for an oMLX model, through `baseUrl` (the recording proxy). */
export function piModel(m: OmlxModel, baseUrl: string, maxOutput = 16_384): Model<"openai-completions"> {
	const context = m.max_context_window ?? m.model_context_length ?? 32_768;
	const canThink = (m.reasoning_levels ?? []).includes("off") || m.thinking_default !== null;
	return {
		id: m.id,
		name: m.id,
		api: "openai-completions",
		provider: "omlx",
		baseUrl,
		reasoning: canThink,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: context,
		maxTokens: Math.min(maxOutput, m.max_tokens ?? maxOutput, Math.floor(context / 4)),
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsStore: false,
			maxTokensField: "max_tokens",
			// oMLX passes chat_template_kwargs to the model's chat template: enable_thinking switches
			// thinking for Qwen, Gemma and LFM templates alike.
			...(canThink ? { thinkingFormat: "chat-template" as const, chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" as const } } } : {}),
		},
	};
}

export function omlxProvider(models: Model<"openai-completions">[], baseUrl: string) {
	return createProvider({
		id: "omlx",
		name: "oMLX",
		baseUrl,
		auth: { apiKey: { name: "oMLX", resolve: async () => ({ auth: { apiKey: OMLX_KEY || "none" } }) } },
		models,
		api: openAICompletionsApi(),
	});
}

/** What oMLX reported for one model request. */
export type RequestRecord = {
	at: number;
	model: string;
	status: number;
	/** Wall time from request to the end of the response, as the agent experienced it. */
	wallMs: number;
	promptTokens?: number;
	cachedTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	ttft?: number;
	promptTps?: number;
	genTps?: number;
	finishReason?: string;
	error?: string;
	/** Messages and tools sent, for sizing (characters of the JSON body). */
	bodyChars: number;
};

/**
 * A local HTTP proxy to oMLX that records each chat completion's usage and timings. pi-ai talks to
 * it as its base URL; the eval reads `take()` after each turn.
 */
export function startRecorder() {
	let records: RequestRecord[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const body = req.method === "POST" ? await req.text() : undefined;
			const started = Date.now();
			const fwdHeaders = new Headers(req.headers);
			fwdHeaders.delete("host");
			if (OMLX_KEY) fwdHeaders.set("authorization", `Bearer ${OMLX_KEY}`);
			const upstream = await fetch(`${OMLX_URL}${url.pathname}${url.search}`, { method: req.method, headers: fwdHeaders, body, signal: req.signal });
			if (!url.pathname.endsWith("/chat/completions") || !body) return upstream;
			let model = "";
			try {
				model = JSON.parse(body).model;
			} catch {}
			const record: RequestRecord = { at: started, model, status: upstream.status, wallMs: 0, bodyChars: body.length };
			if (!upstream.body) {
				record.wallMs = Date.now() - started;
				records.push(record);
				return upstream;
			}
			const [mine, theirs] = upstream.body.tee();
			void (async () => {
				const decoder = new TextDecoder();
				let buffer = "";
				let text = "";
				try {
					for await (const chunk of mine as unknown as AsyncIterable<Uint8Array>) {
						const s = decoder.decode(chunk, { stream: true });
						if (upstream.status !== 200) text += s;
						buffer += s;
						let i: number;
						while ((i = buffer.indexOf("\n")) >= 0) {
							const line = buffer.slice(0, i).trim();
							buffer = buffer.slice(i + 1);
							if (!line.startsWith("data:") || line === "data: [DONE]") continue;
							try {
								const m = JSON.parse(line.slice(5));
								const fin = m.choices?.[0]?.finish_reason;
								if (fin) record.finishReason = fin;
								const u = m.usage;
								if (u) {
									record.promptTokens = u.prompt_tokens;
									record.cachedTokens = u.prompt_tokens_details?.cached_tokens;
									record.completionTokens = u.completion_tokens;
									record.reasoningTokens = u.completion_tokens_details?.reasoning_tokens;
									record.ttft = u.time_to_first_token;
									record.promptTps = u.prompt_tokens_per_second;
									record.genTps = u.generation_tokens_per_second;
								}
							} catch {}
						}
					}
				} catch (e) {
					record.error = (e as Error).message;
				}
				if (upstream.status !== 200) record.error = text.slice(0, 500);
				record.wallMs = Date.now() - started;
				records.push(record);
			})();
			return new Response(theirs, { status: upstream.status, headers: upstream.headers });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		/** Records finished since the last take, oldest first. */
		take() {
			const out = records.sort((a, b) => a.at - b.at);
			records = [];
			return out;
		},
		stop: () => server.stop(true),
	};
}

/** Loads a model by sending a one-token request; returns how long that took. */
export async function warm(model: string): Promise<number> {
	const t = Date.now();
	const r = await fetch(`${OMLX_URL}/v1/chat/completions`, {
		method: "POST",
		headers: { ...headers(), "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 1, chat_template_kwargs: { enable_thinking: false } }),
	});
	await r.text();
	if (!r.ok) throw new Error(`${model}: HTTP ${r.status}`);
	return Date.now() - t;
}
