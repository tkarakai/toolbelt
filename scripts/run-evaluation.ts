import { extractSignedApp } from "./app-bundle";
import pkg from "../package.json";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
if (process.argv.includes("--help")) {
  console.log(
    "bun scripts/run-evaluation.ts [path/to/Toolbelt.app]\nCopies the built app to a fresh temporary profile and launches it with isolated plugin data, renderer state, TUI installation home and shortcut. It does not replace your installed Toolbelt.",
  );
  process.exit(0);
}
const source = resolve(
  process.argv[2] ?? "build.noindex/stable-macos-arm64/Toolbelt.app",
);
if (!existsSync(join(source, "Contents/MacOS/launcher")))
  throw new Error("Build the app first: bun run build");
const root = mkdtempSync(join(tmpdir(), "toolbelt-v2-review-"));
const app = join(root, "Apps/Toolbelt.app");
mkdirSync(join(root, "home"), { recursive: true });
if (process.argv[2]) cpSync(source, app, { recursive: true });
else
  await extractSignedApp(
    resolve("artifacts/stable-macos-arm64-Toolbelt.app.tar.zst"),
    join(root, "Apps"),
    {
      archiveName: "Toolbelt.app",
      identifier: "io.github.tkarakai.toolbelt",
      version: pkg.version,
    },
  );
writeFileSync(
  join(root, "settings.json"),
  JSON.stringify({
    shortcut: "Command+Control+Option+Shift+Y",
    theme: "graphite",
    mode: "system",
  }),
);
console.log(
  `Evaluation profile: ${root}\nApp copy: ${app}\nTUI install/undo operates only in ${join(root, "home")}\nShortcut: Command+Control+Option+Shift+Y`,
);
const child = Bun.spawn([join(app, "Contents/MacOS/launcher")], {
  env: {
    ...process.env,
    TOOLBELT_CONFIG_DIR: root,
    TOOLBELT_PS_HOME: join(root, "home"),
    TOOLBELT_OPEN_WINDOW: "1",
  },
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
