// Fetches the plugin releases the evaluation runs (plugins.json) into .cache/: the verified release
// archive the host runs, and the source at the release commit, whose model module seeds the data.
// The plugins aren't copied into ToolBelt: the cache lives outside the repository (TOOLBELT_EVAL_CACHE,
// default ~/.cache/toolbelt-agent-eval), so their sources and tests stay out of the host's builds and tests.
// bun src/setup.ts [--force]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pins from "../plugins.json";

export const CACHE = process.env.TOOLBELT_EVAL_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "toolbelt-agent-eval");
export type Pin = (typeof pins)["ontrack"];

export const pluginDir = (id: keyof typeof pins) => join(CACHE, `${id}@${pins[id].tag}`, "plugin");
export const sourceDir = (id: keyof typeof pins) => join(CACHE, `${id}@${pins[id].tag}`, "source");

async function run(cmd: string[], cwd?: string) {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err || out}`);
	return out.trim();
}

async function fetchPlugin(id: keyof typeof pins, force: boolean) {
	const pin = pins[id];
	const plugin = pluginDir(id);
	const source = sourceDir(id);
	if (!force && existsSync(join(plugin, "toolbelt.json")) && existsSync(join(source, "node_modules"))) return;
	rmSync(join(CACHE, `${id}@${pin.tag}`), { recursive: true, force: true });
	mkdirSync(plugin, { recursive: true });

	const res = await fetch(pin.asset);
	if (!res.ok) throw new Error(`${pin.asset}: HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== pin.sha256) throw new Error(`${id}: archive sha256 ${digest} does not match the pinned ${pin.sha256}`);
	const archive = join(CACHE, `${id}@${pin.tag}`, "plugin.tar.gz");
	await Bun.write(archive, bytes);
	await run(["tar", "xzf", archive, "-C", plugin]);

	await run(["git", "clone", "--quiet", "--depth", "1", "--branch", pin.tag, `https://github.com/${pin.repo}.git`, source]);
	const head = await run(["git", "rev-parse", "HEAD"], source);
	if (head !== pin.commit) throw new Error(`${id}: ${pin.tag} is ${head}, not the pinned ${pin.commit}`);
	// Only runtime dependencies (the SDK the model module imports), exactly as locked.
	await run(["bun", "install", "--frozen-lockfile", "--production", "--ignore-scripts"], source);
	console.log(`${id} ${pin.tag}: plugin and source ready in ${join(CACHE, `${id}@${pin.tag}`)}`);
}

export async function setup(force = false) {
	mkdirSync(CACHE, { recursive: true });
	for (const id of Object.keys(pins) as (keyof typeof pins)[]) await fetchPlugin(id, force);
}

if (import.meta.main) await setup(process.argv.includes("--force"));
