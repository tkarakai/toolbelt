#!/usr/bin/env bun
// Bundles each built-in plugin (plugins/<id>/) into build-plugins/<id>/: one index.js plus its
// toolbelt.json — the same shape an installed plugin will have. Run: bun scripts/build-plugins.ts
//
// Processes also gets running (vendored in plugins/processes/running/), the way running's own
// scripts/build.ts builds it:
//   build-plugins/processes/running-core.js  running-core (src/serve.ts), which the plugin drives
//   build-plugins/processes/bin/running      the terminal UI (src/main.tsx), executable
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { parseManifest } from "../src/shared/protocol";

const out = "build-plugins";

async function bundle(entry: string, opts: Partial<Parameters<typeof Bun.build>[0]> = {}) {
	const res = await Bun.build({ entrypoints: [entry], target: "bun", minify: false, ...opts });
	if (!res.success) {
		for (const l of res.logs) console.error(l);
		process.exit(1);
	}
	return res.outputs[0];
}

rmSync(out, { recursive: true, force: true });
for (const id of readdirSync("plugins")) {
	const dir = join("plugins", id);
	const file = join(dir, "toolbelt.json");
	if (!existsSync(file)) continue;
	const manifest = parseManifest(JSON.parse(readFileSync(file, "utf8")));
	mkdirSync(join(out, id), { recursive: true });
	await Bun.write(join(out, id, "index.js"), await bundle(join(dir, manifest.entry)));
	writeFileSync(join(out, id, "toolbelt.json"), JSON.stringify({ ...manifest, entry: "index.js" }, null, "\t") + "\n");
	console.log(`${out}/${id}  ${manifest.name} ${manifest.version}`);
}

// ── running ──
const running = "plugins/processes/running";
// Ink only loads react-devtools-core when DEV=true; running stubs it (its tsconfig `paths`) so
// the bundle stays self-contained. Same here, explicitly.
const stubDevtools: BunPlugin = {
	name: "stub react-devtools-core",
	setup(b) {
		b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: resolve(running, "src/stubs/react-devtools-core.ts") }));
	},
};
// The Bun the bundle was built and tested with (`running --help` shows it, and `--version` warns
// when another runs it). Toolbelt's app ships the same Bun it's built with.
const define = { __BUILT_WITH_BUN__: JSON.stringify(Bun.version) };
await Bun.write(join(out, "processes/running-core.js"), await bundle(join(running, "src/serve.ts"), { plugins: [stubDevtools], define }));
const bin = join(out, "processes/bin/running");
mkdirSync(join(out, "processes/bin"), { recursive: true });
const tui = await (await bundle(join(running, "src/main.tsx"), { plugins: [stubDevtools], define, minify: true })).text();
writeFileSync(bin, tui.startsWith("#!") ? tui : `#!/usr/bin/env bun\n${tui}`);
chmodSync(bin, 0o755);
const version = JSON.parse(readFileSync(join(running, "package.json"), "utf8")).version;
console.log(`${out}/processes/running-core.js, bin/running  running ${version} (Bun ${Bun.version})`);
