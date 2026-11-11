import { readdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import pkg from "../package.json" with { type: "json" };
import { execFileSync } from "node:child_process";

const commit = process.env.TOOLBELT_SOURCE_COMMIT || execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {encoding: "utf8"}).trim();
const packages = new Map<string, {name: string; version: string; license: string; text: string; url?: string; licenseUrl?: string}>();
const visited = new Set<string>();
function collect(name: string, from: string) {
 const require = createRequire(join(from, "package.json"));
 let root: string;
 try { root = dirname(require.resolve(`${name}/package.json`)); }
 catch {
   try {
     root = dirname(require.resolve(name));
     while (dirname(root) !== root) {
       if (existsSync(join(root, "package.json")) && JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name === name) break;
       root = dirname(root);
     }
   } catch {
     // Some asset-only packages export neither a JS entry nor package.json.
     const local = join(from, "node_modules", name), top = resolve("node_modules", name);
     root = existsSync(join(local, "package.json")) ? local : top;
     if (!existsSync(join(root, "package.json"))) return;
   }
 }
 root = realpathSync(root);
 if (visited.has(root)) return;
 visited.add(root);
 const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
 const files = readdirSync(root).filter(f => /^(licen[sc]e|notice|copying)([._-]|$)/i.test(f));
 const licenseFile = files.find(f => /^licen[sc]e/i.test(f));
 const licenseUrl = licenseFile ? `https://cdn.jsdelivr.net/npm/${meta.name}@${meta.version}/${encodeURIComponent(licenseFile)}` : typeof meta.license === "string" && /^[A-Za-z0-9.-]+$/.test(meta.license) ? `https://spdx.org/licenses/${meta.license}.html` : undefined;
 const repo = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
 const repository = repo?.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^github:/, "https://github.com/").replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");
 const url = /^https?:\/\//.test(repository || "") ? repository : meta.homepage;
 packages.set(`${meta.name}@${meta.version}`, {
   name: meta.name, version: meta.version, licenseUrl, license: typeof meta.license === "string" ? meta.license : "See license text",
   url: /^https?:\/\//.test(url || "") ? url : undefined,
   text: files.filter(f => !readdirSync(root, {withFileTypes:true}).find(e => e.name === f)?.isDirectory()).map(f => readFileSync(join(root, f), "utf8")).join("\n\n") || "License text is available in the upstream package.",
 });
 for (const dependency of Object.keys({...meta.dependencies, ...meta.optionalDependencies})) collect(dependency, root);
}
for (const name of Object.keys({...pkg.dependencies, electrobun: ""})) collect(name, process.cwd());
const acknowledgments = [...packages.values()].sort((a,b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
writeFileSync("src/ui/build-info.ts", `// Generated at UI build time.\nexport const buildInfo = ${JSON.stringify({version: pkg.version, commit})};\n`);
writeFileSync("src/ui/acknowledgments.ts", `// Generated dependency notices, loaded on demand.\nexport const acknowledgments = ${JSON.stringify(acknowledgments)};\n`);
