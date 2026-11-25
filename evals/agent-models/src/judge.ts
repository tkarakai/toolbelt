// Optional model-graded review of each run against its case's rubric. The judge sees the person's
// turns, what ToolBelt returned to the agent (the ground truth) and the agent's answers, and scores
// helpfulness and faithfulness. Deterministic checks stay the primary signal; the judge catches what
// string checks can't (a wrong claim beside the right names, a muddled or padded answer).
//   --judge omlx/<model id>       a local model (use a stronger one than those judged)
//   --judge <provider>/<model>    any pi-ai built-in provider with its key in the environment
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import type { CaseRun } from "./agent";
import { caseById } from "./cases";
import { omlxProvider, omlxStatus, OMLX_URL, piModel } from "./omlx";

export type Verdict = { score: number; faithful: boolean; rubric: boolean[]; issues: string[]; judge: string; error?: string };

const SYSTEM = `You grade an AI assistant built into ToolBelt, a Mac app whose plugins show the person's tasks and more. The assistant can only read ToolBelt through tools.
You get the rubric for a good answer, the conversation, and for each turn what ToolBelt's tools returned to the assistant. The tool results are the ground truth: an answer is unfaithful if it states something they don't support, gets a fact wrong, or claims to have done something it can't.
Reply with JSON only, no prose: {"score": 1-5, "faithful": true|false, "rubric": [true|false per rubric item, in order], "issues": ["short concrete problems"]}.
Score: 5 complete, correct and well put; 4 correct with minor gaps; 3 useful but a notable gap or a minor error; 2 a significant error or mostly unhelpful; 1 wrong, invented or harmful.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more characters]` : s);

function prompt(run: CaseRun) {
	const c = caseById(run.case);
	const turns = run.turns
		.map((t, i) => {
			const tools = t.calls.map((x) => `→ ${x.name}(${JSON.stringify(x.args)})${x.isError ? " [error]" : ""}\n${clip(x.output, 12_000)}`).join("\n\n");
			return `### Turn ${i + 1}\nPerson: ${t.user}\n\nTool results:\n${tools || "(no tool calls)"}\n\nAssistant: ${t.answer || `(no answer: ${t.status} ${t.reason ?? ""})`}`;
		})
		.join("\n\n");
	return `Case: ${c?.title ?? run.case}\nNow: ${run.startedAt}\n\nRubric:\n${(c?.rubric ?? []).map((r, i) => `${i + 1}. ${r}`).join("\n")}\n\n${turns}`;
}

async function judgeModel(spec: string) {
	const [provider, ...rest] = spec.split("/");
	const id = rest.join("/");
	if (provider === "omlx") {
		const om = (await omlxStatus()).models.find((m) => m.id === id);
		if (!om) throw new Error(`oMLX has no model ${id}`);
		const model = piModel(om, `${OMLX_URL}/v1`, 4096);
		const models = builtinModels();
		models.setProvider(omlxProvider([model], `${OMLX_URL}/v1`));
		return { models, model: model as Model<never> };
	}
	const models = builtinModels();
	const model = models.getModel(provider, id);
	if (!model) throw new Error(`unknown judge model ${spec}`);
	return { models, model: model as Model<never> };
}

export async function judgeRuns(dir: string, spec: string) {
	const { models, model } = await judgeModel(spec);
	const runs = readFileSync(join(dir, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CaseRun);
	const verdicts: (Verdict | null)[] = [];
	for (const [i, run] of runs.entries()) {
		if (run.error || !caseById(run.case)) {
			verdicts.push(null);
			continue;
		}
		let v: Verdict;
		try {
			const reply = await models.completeSimple(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content: prompt(run), timestamp: Date.now() }] }, { reasoning: "off" } as never);
			const text = reply.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
			const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
			v = { score: Number(json.score), faithful: json.faithful === true, rubric: (json.rubric ?? []).map(Boolean), issues: (json.issues ?? []).map(String), judge: spec };
		} catch (e) {
			v = { score: 0, faithful: false, rubric: [], issues: [], judge: spec, error: (e as Error).message };
		}
		verdicts.push(v);
		console.log(`  judged ${i + 1}/${runs.length} ${run.candidate} ${run.case}: ${v.error ? `error ${v.error}` : `${v.score}/5${v.faithful ? "" : " unfaithful"}`}`);
	}
	writeFileSync(join(dir, "judge.json"), JSON.stringify(verdicts, null, "\t"));
}
