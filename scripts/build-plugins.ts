#!/usr/bin/env bun
// Bundles each built-in plugin (plugins/<id>/) into build-plugins/<id>/: one index.js plus its
// toolbelt.json — the same shape an installed plugin will have. Run: bun scripts/build-plugins.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../src/shared/protocol";

const out = "build-plugins";
rmSync(out, { recursive: true, force: true });
for (const id of readdirSync("plugins")) {
	const dir = join("plugins", id);
	const file = join(dir, "toolbelt.json");
	if (!existsSync(file)) continue;
	const manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")));
	const res = await Bun.build({ entrypoints: [join(dir, manifest.entry)], target: "bun", minify: false });
	if (!res.success) {
		for (const l of res.logs) console.error(l);
		process.exit(1);
	}
	mkdirSync(join(out, id), { recursive: true });
	await Bun.write(join(out, id, "index.js"), res.outputs[0]);
	writeFileSync(join(out, id, "toolbelt.json"), JSON.stringify({ ...manifest, entry: "index.js" }, null, "\t") + "\n");
	console.log(`${out}/${id}  ${manifest.name} ${manifest.version}`);
}
