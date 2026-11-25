// An MCP client for the evaluation: starts the real stdio shim (`toolbelt mcp`), as Claude Code
// would, and runs steps against it, recording every JSON-RPC line in both directions.
// bun mcp-run.ts <case dir> <steps.json>
// Steps: {"tool": name, "args": {...}} · {"resource": uri} · {"subscribe": uri} · {"unsubscribe": uri}
//        {"person": method, "params": {...}}  (what the person does in ToolBelt's UI, over the preview RPC)
//        {"wait": ms} · {"awaitNotification": method, "timeout": ms}
// Options in steps.json: {"client": "...", "mode": "interactive|autonomous", "steps": [...]}
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [dir, stepsFile] = process.argv.slice(2);
const spec = JSON.parse(await Bun.file(stepsFile).text());
const repo = join(import.meta.dir, "../../..");
const socket = `${process.env.TMPDIR}tb-agent-eval.sock`;
const argv = [process.execPath, join(repo, "src/cli/toolbelt.ts"), "--socket", socket, "mcp", ...(spec.mode === "autonomous" ? ["--autonomous"] : [])];
const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const transcript: { t: number; dir: ">" | "<"; message: unknown }[] = [];
const start = Date.now();
const pending = new Map<number, (m: any) => void>();
const notifications: any[] = [];
let next = 1;
const send = (message: any) => {
	transcript.push({ t: Date.now() - start, dir: ">", message });
	proc.stdin.write(JSON.stringify(message) + "\n");
	proc.stdin.flush();
};
const request = (method: string, params: unknown = {}) =>
	new Promise<any>((resolve) => {
		const id = next++;
		pending.set(id, resolve);
		send({ jsonrpc: "2.0", id, method, params });
	});
(async () => {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let i: number;
		while ((i = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (!line.trim()) continue;
			const m = JSON.parse(line);
			transcript.push({ t: Date.now() - start, dir: "<", message: m });
			if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)!(m), pending.delete(m.id);
			else if (m.method) notifications.push(m);
		}
	}
})();
const person = async (method: string, params: unknown) => {
	const p = Bun.spawn([process.execPath, join(import.meta.dir, "rpc.ts"), "5281", method, JSON.stringify(params)], { stdout: "pipe" });
	return (await new Response(p.stdout).text()).trim();
};
const results: any[] = [];
const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: spec.client ?? "eval-agent", version: "1.0" } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
results.push({ step: "initialize", protocolVersion: init.result?.protocolVersion, instructions: init.result?.instructions });
const tools = await request("tools/list");
results.push({ step: "tools/list", tools: tools.result?.tools?.map((t: any) => t.name) });
for (const step of spec.steps) {
	const t0 = Date.now();
	if (step.tool) {
		const r = await request("tools/call", { name: step.tool, arguments: step.args ?? {} });
		results.push({ step: `tools/call ${step.tool}`, args: step.args ?? {}, ms: Date.now() - t0, isError: !!r.result?.isError, error: r.error, text: r.result?.content?.map((c: any) => c.text).join("\n") });
	} else if (step.resource) {
		const r = await request("resources/read", { uri: step.resource });
		results.push({ step: `resources/read ${step.resource}`, ms: Date.now() - t0, error: r.error, text: r.result?.contents?.[0]?.text });
	} else if (step.subscribe) {
		const r = await request("resources/subscribe", { uri: step.subscribe });
		results.push({ step: `resources/subscribe ${step.subscribe}`, error: r.error, ok: !r.error });
	} else if (step.unsubscribe) {
		await request("resources/unsubscribe", { uri: step.unsubscribe });
		results.push({ step: `resources/unsubscribe ${step.unsubscribe}` });
	} else if (step.person) {
		results.push({ step: `person: ${step.person}`, params: step.params, result: await person(step.person, step.params ?? {}) });
	} else if (step.wait) {
		await Bun.sleep(step.wait);
	} else if (step.awaitNotification) {
		const end = Date.now() + (step.timeout ?? 5000);
		const seen = notifications.length;
		let got: any = null;
		while (Date.now() < end && !got) {
			got = notifications.slice(0).find((n, i) => n.method === step.awaitNotification && (step.fresh ? i >= seen : true));
			if (!got) await Bun.sleep(50);
		}
		results.push({ step: `await ${step.awaitNotification}`, ms: Date.now() - t0, received: got });
	}
}
proc.stdin.end();
await Promise.race([proc.exited, Bun.sleep(2000)]);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "transcript.jsonl"), transcript.map((l) => JSON.stringify(l)).join("\n") + "\n");
writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2) + "\n");
for (const r of results.slice(2)) {
	console.log(`\n=== ${r.step}${r.args ? " " + JSON.stringify(r.args) : ""}${r.ms !== undefined ? ` (${r.ms} ms)` : ""}${r.isError ? " [isError]" : ""}`);
	console.log(r.text ?? r.result ?? JSON.stringify(r.received ?? r.error ?? r.ok ?? ""));
}
process.exit(0);
