// Speed and memory per model, outside any conversation: load time, then one request per prompt size
// (prefill speed and time to first token as the context grows, decode speed), with a nonce first so
// oMLX's prefix cache can't answer from an earlier request. Writes bench.json and prints a table.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OMLX_KEY, OMLX_URL, omlxStatus, warm } from "./omlx";

export const SIZES = [1_000, 8_000, 32_000, 60_000];
// Text shaped like what an agent reads from ToolBelt: task rows with labels, dates and notes.
const ROW = (i: number) =>
	`- [#${i}] Task number ${i} about project work — [Project ${i % 7}, ${["High", "Medium", "Low"][i % 3]}] · 2026-12-${String((i % 28) + 1).padStart(2, "0")} · Notes: follow up with the owner, check the numbers, and write an update when done.\n`;

export type BenchRow = { model: string; loadMs: number; memory: number | null; size: number; promptTokens?: number; ttft?: number; promptTps?: number; genTps?: number; wallMs: number; error?: string };

async function once(model: string, chars: number): Promise<Omit<BenchRow, "model" | "loadMs" | "memory" | "size">> {
	let text = `Nonce ${crypto.randomUUID()}. Here is a task list:\n`;
	for (let i = 1; text.length < chars; i++) text += ROW(i);
	const t = Date.now();
	const r = await fetch(`${OMLX_URL}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(OMLX_KEY ? { Authorization: `Bearer ${OMLX_KEY}` } : {}) },
		body: JSON.stringify({ model, messages: [{ role: "user", content: `${text}\nSummarize this list in about 150 words.` }], max_tokens: 256, chat_template_kwargs: { enable_thinking: false } }),
	});
	const body = await r.json().catch(() => ({}));
	if (!r.ok) return { wallMs: Date.now() - t, error: JSON.stringify(body).slice(0, 300) };
	const u = body.usage ?? {};
	return { promptTokens: u.prompt_tokens, ttft: u.time_to_first_token, promptTps: u.prompt_tokens_per_second, genTps: u.generation_tokens_per_second, wallMs: Date.now() - t };
}

export async function bench(ids: string[], out: string, sizes = SIZES) {
	const rows: BenchRow[] = [];
	const status = await omlxStatus();
	console.log(["model", "load", "memory", "prompt", "ttft", "prefill tok/s", "decode tok/s"].join("\t"));
	for (const model of ids) {
		const om = status.models.find((m) => m.id === model);
		if (!om) {
			console.log(`${model}: not in oMLX`);
			continue;
		}
		const loadMs = await warm(model).catch(() => -1);
		const memory = (await omlxStatus()).models.find((m) => m.id === model)?.actual_size ?? null;
		const limit = om.max_context_window ?? om.model_context_length ?? 32_000;
		for (const size of sizes) {
			// About 4 characters a token; stay under the model's allowed context.
			if (size + 512 > limit) continue;
			const r = await once(model, size * 3);
			const row = { model, loadMs, memory, size, ...r };
			rows.push(row);
			console.log([model, `${(loadMs / 1000).toFixed(1)}s`, memory ? `${(memory / 1e9).toFixed(1)}GB` : "-", r.promptTokens ?? size, r.ttft?.toFixed(1) ?? "-", r.promptTps?.toFixed(0) ?? "-", r.genTps?.toFixed(1) ?? "-", r.error ?? ""].join("\t"));
		}
	}
	writeFileSync(join(out, "bench.json"), JSON.stringify(rows, null, "\t"));
	return rows;
}
