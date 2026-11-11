import { packageTester } from "./tester-artifacts";
import { extractSignedApp } from "./app-bundle";
import pkg from "../package.json";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const source = resolve(import.meta.dirname, "..");
// A build staging folder, not a Git checkout. Never replaces the main app config or build lock.
const stage = mkdtempSync(join(tmpdir(), "toolbelt-tester-build-"));
async function run(args: string[]) {
  const proc = Bun.spawn(args, {
    cwd: stage,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await proc.exited) throw new Error(`Failed: ${args.join(" ")}`);
}
try {
  for (const path of [
    "src",
    "scripts",
    "assets",
    "dev-icon.iconset",
    "package.json",
    "seed.config.json",
    "bun.lock",
    "tsconfig.json",
  ])
    cpSync(join(source, path), join(stage, path), { recursive: true });
  symlinkSync(join(source, "node_modules"), join(stage, "node_modules"));
  cpSync(
    join(source, "electrobun.tester.config.ts"),
    join(stage, "electrobun.config.ts"),
  );
  writeFileSync(
    join(stage, "index.html"),
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/scripts/tester-main.tsx"></script></body></html>',
  );
  writeFileSync(
    join(stage, "vite.config.ts"),
    `import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';import tailwindcss from '@tailwindcss/vite';import {electrobunViteAliases} from './.hutch/devkit/api/config/electrobun-vite.ts';import {resolve} from 'node:path';export default defineConfig({plugins:[react(),tailwindcss()],resolve:{alias:[...electrobunViteAliases(resolve('.hutch/devkit')),{find:/^@\\//,replacement:resolve('src/ui')+'/'}]},base:'./',build:{outDir:'dist-tester',chunkSizeWarningLimit:2000}});`,
  );
  await run(["bun", "run", "--bun", "electrobun", "prepare"]);
  await run(["bun", "run", "--bun", "vite", "build"]);
  await run(["bun", "run", "--bun", "electrobun", "build", "--env=stable"]);
  const output = join(source, "artifacts-tester");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(join(stage, "build-tester.noindex"), join(output, "build"), {
    recursive: true,
  });
  // Include Electrobun's self-contained update archive as well as the runnable native app.
  try {
    cpSync(join(stage, "artifacts"), join(output, "archives"), {
      recursive: true,
    });
  } catch {}
  const real = join(output, "build/stable-macos-arm64");
  rmSync(real, { recursive: true, force: true });
  await extractSignedApp(
    join(
      output,
      "archives/stable-macos-arm64-ToolbeltPluginTester.app.tar.zst",
    ),
    real,
    {
      archiveName: "Toolbelt Plugin Tester.app",
      name: "Toolbelt Plugin Tester.app",
      identifier: "io.github.tkarakai.toolbelt.tester",
      version: pkg.version,
    },
  );
  rmSync(join(output, "archives/macos-arm64-ToolbeltPluginTester.dmg"), {
    force: true,
  });
  await packageTester(
    join(real, "Toolbelt Plugin Tester.app"),
    output,
    pkg.version,
  );
  console.log(`Tester artifacts: ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
