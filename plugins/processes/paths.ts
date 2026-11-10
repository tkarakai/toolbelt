// Where the Processes plugin finds running (vendored in ./running/, bundled by
// scripts/build-plugins.ts next to the plugin's index.js).
//
//   running-core: RUNNING_CORE_SCRIPT → <plugin>/running-core.js (built) → <plugin>/running/src/serve.ts (source)
//   the TUI:      <plugin>/bin/running (built) → <plugin>/running/src/main.tsx (source)
//
// In the app, <plugin> is Toolbelt.app/Contents/Resources/app/plugins/processes; from source
// (tests, `bun run preview` uses the built one) it's plugins/processes.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const pluginDir = import.meta.dir;

const first = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? paths[paths.length - 1]!;

export function coreScript(dir = pluginDir, env: Record<string, string | undefined> = process.env) {
	return env.RUNNING_CORE_SCRIPT || first(join(dir, "running-core.js"), join(dir, "running/src/serve.ts"));
}

export function tuiScript(dir = pluginDir) {
	return first(join(dir, "bin/running"), join(dir, "running/src/main.tsx"));
}
